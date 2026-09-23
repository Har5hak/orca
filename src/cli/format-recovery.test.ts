import { describe, expect, it, vi } from 'vitest'

import { formatCliError, reportCliError } from './format'
import { formatPinnedRetryCommandStep } from './cli-error'
import { RuntimeClientError, RuntimeRpcFailureError } from './runtime-client'

function selectorNotFound(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_selector',
    ok: false,
    error: { code: 'selector_not_found', message: 'selector_not_found' },
    _meta: { runtimeId: 'runtime_local' }
  })
}

function unconfirmedLinearRetry(): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req_linear_retry',
    ok: false,
    error: {
      code: 'linear_write_unconfirmed',
      message: 'Linear may have applied the write.',
      data: {
        writeId: 'write-1',
        nextSteps: ['Retry once with the exact `retryCommandArgs` from this error.'],
        retryCommandArgs: ['orca', 'linear', 'milestone', 'clear', 'ENG-1', '--json']
      }
    },
    _meta: { runtimeId: 'runtime_remote' }
  })
}

describe('worktree selector recovery', () => {
  it('names the offending value and the valid forms on a bare repo id', () => {
    const output = formatCliError(selectorNotFound(), {
      commandPath: ['orchestration', 'worker-start'],
      worktreeSelector: 'id:github:stablyai/orca'
    })

    expect(output).toContain('No Orca workspace matched the worktree selector')
    expect(output).toContain('id:github:stablyai/orca')
    expect(output).toContain('Did you mean: id:github:stablyai/orca::<absolute-path>')
    expect(output).toContain('Valid selector forms:')
    expect(output).toContain('a bare repository id is not a worktree id')
  })

  it('carries the same recovery into the --json failure envelope', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(selectorNotFound(), true, {
      commandPath: ['terminal', 'create'],
      worktreeSelector: 'path:/nope'
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        code: 'selector_not_found',
        data: { selector: 'path:/nope', validSelectorForms: expect.arrayContaining(['current']) }
      }
    })
    log.mockRestore()
  })

  it('keeps the selector grammar when the error already carries mutation recovery data', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(
      new RuntimeRpcFailureError({
        id: 'req_selector',
        ok: false,
        error: {
          code: 'selector_not_found',
          message: 'selector_not_found',
          // The mutation-recovery layer already attached its request id.
          data: { orchestrationRequestId: 'req_abc', nextSteps: ['Run request-show first.'] }
        },
        _meta: { runtimeId: 'runtime_local' }
      }),
      true,
      { commandPath: ['orchestration', 'worker-start'], worktreeSelector: 'bare-repo-id' }
    )

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      error: {
        data: {
          orchestrationRequestId: 'req_abc',
          selector: 'bare-repo-id',
          validSelectorForms: expect.arrayContaining(['current']),
          nextSteps: expect.arrayContaining(['Run request-show first.'])
        }
      }
    })
    log.mockRestore()
  })

  it('keeps both recoveries in the text message for a local selector error', () => {
    const output = formatCliError(
      new RuntimeClientError('selector_not_found', 'selector_not_found', {
        orchestrationRequestId: 'req_abc',
        nextSteps: ['Run request-show first.']
      }),
      { worktreeSelector: 'bare-repo-id' }
    )

    expect(output).toContain('Valid selector forms:')
    expect(output).toContain('Run request-show first.')
  })

  it('stays silent when no worktree selector was passed', () => {
    expect(formatCliError(selectorNotFound(), { commandPath: ['worktree', 'show'] })).toBe(
      'selector_not_found'
    )
  })
})

describe('CLI error recovery', () => {
  it('does not render an unsafe multiline retry command for Windows cmd', () => {
    const args = [
      'orca',
      'linear',
      'label',
      'description',
      'set',
      '--description=line 1\r\nline 2',
      '--write-id=11111111-1111-4111-8111-111111111111'
    ]

    const output = formatPinnedRetryCommandStep(args, 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe'
    })

    expect(output).toContain('cannot represent an argument containing a line break safely')
    expect(output).toContain(JSON.stringify(args))
    expect(output).not.toContain('line 1\r\nline 2')
  })

  it('pins a non-secret remote route and refuses a secret-only local retry', () => {
    const args = ['orca', 'linear', 'milestone', 'clear', 'ENG-1', '--write-id=write-1']

    expect(
      formatPinnedRetryCommandStep(
        args,
        'darwin',
        {},
        {
          remoteEnvironmentSelector: 'gpu',
          remoteRoutingRequired: true
        }
      )
    ).toContain('--environment=gpu')
    const secretOnly = formatPinnedRetryCommandStep(
      args,
      'darwin',
      {},
      {
        remoteRoutingRequired: true
      }
    )
    expect(secretOnly).toContain('same paired Orca runtime')
    expect(secretOnly).toContain('write-1')
    expect(secretOnly).not.toContain('ENG-1')
    expect(secretOnly).not.toContain('orca linear')
    expect(secretOnly).not.toContain('--pairing-code')
  })

  it('pins the non-secret remote route in JSON retry arguments', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(unconfirmedLinearRetry(), true, {
      remoteEnvironmentSelector: 'gpu',
      remoteRoutingRequired: true
    })

    const output = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(output.error.data.retryCommandArgs).toEqual([
      'orca',
      'linear',
      'milestone',
      'clear',
      'ENG-1',
      '--json',
      '--environment=gpu'
    ])
    log.mockRestore()
  })

  it('blocks a local JSON retry when only secret pairing can preserve the route', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(unconfirmedLinearRetry(), true, { remoteRoutingRequired: true })

    const output = JSON.parse(String(log.mock.calls[0]?.[0]))
    expect(output.error.data).not.toHaveProperty('retryCommandArgs')
    expect(output.error.data).not.toHaveProperty('retryCommandArgsWithoutRouting')
    expect(output.error.data).toMatchObject({
      writeId: 'write-1',
      retryRouting: {
        required: true,
        kind: 'pairing',
        secretOmitted: true,
        retryBlocked: true
      }
    })
    expect(JSON.stringify(output)).not.toContain('ENG-1')
    expect(JSON.stringify(output)).not.toContain('"orca"')
    expect(JSON.stringify(output)).not.toContain('--pairing-code')
    log.mockRestore()
  })

  it('prints did-you-mean next steps for an unknown-command error carrying data', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown command: worktree remov', {
      suggestions: ['worktree rm'],
      nextSteps: ['Did you mean: orca worktree rm']
    })

    const output = formatCliError(error)

    expect(output).toContain('Unknown command: worktree remov')
    expect(output).toContain('Next step: Did you mean: orca worktree rm')
  })

  it('prefers structured recovery over generic computer hints in text output', () => {
    const error = new RuntimeClientError('invalid_argument', 'Unknown flag --forcce', {
      nextSteps: ['Did you mean: --force']
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Did you mean: --force')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('prefers RPC recovery over generic computer hints in text output', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_recovery',
      ok: false,
      error: {
        code: 'invalid_argument',
        message: 'Unknown runtime argument',
        data: { nextSteps: ['Use the runtime-specific option'] }
      },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Next step: Use the runtime-specific option')
    expect(output).not.toContain('Fix the command flags or RPC params')
  })

  it('keeps generic computer hints when an RPC error has no recovery data', () => {
    const error = new RuntimeRpcFailureError({
      id: 'req_rpc_fallback',
      ok: false,
      error: { code: 'invalid_argument', message: 'Invalid computer argument' },
      _meta: { runtimeId: 'runtime_local' }
    })

    const output = formatCliError(error, { commandPath: ['computer', 'click'] })

    expect(output).toContain('Fix the command flags or RPC params')
  })

  it('does not replace mutation recovery with generic runtime startup advice', () => {
    const error = new RuntimeClientError(
      'runtime_unavailable',
      'Re-issue the same command with --retry-request mutation_1.',
      { orchestrationRequestId: 'mutation_1' }
    )

    const output = formatCliError(error)

    expect(output).toContain('--retry-request mutation_1')
    expect(output).not.toContain('orca open')
  })
})
