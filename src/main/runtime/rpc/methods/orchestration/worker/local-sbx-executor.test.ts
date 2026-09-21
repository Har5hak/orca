import { describe, expect, it, vi } from 'vitest'
import {
  LocalSbxInboxContract,
  LocalSbxResultContract,
  LocalSbxTaskContract
} from './local-sbx-contracts'
import {
  runLocalSbxExecutor,
  type LocalSbxArgvAdapter,
  type LocalSbxCommandResult,
  type LocalSbxHostAuthority
} from './local-sbx-executor'

const NONCE = 'n'.repeat(32)
const BINDING = {
  runId: 'run_1',
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  spec: 'Return a synthetic result without reading or writing files.'
}

function success(stdout = ''): LocalSbxCommandResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

function failure(stderr: string): LocalSbxCommandResult {
  return { code: 1, signal: null, stdout: '', stderr, timedOut: false }
}

function versionOutput(): string {
  return JSON.stringify({ client: { version: '0.43.0' }, server: { state: 'running' } })
}

function inventory(status: 'running' | 'stopped', overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sandboxes: [
      {
        name: 'orca-ctx-1',
        agent: 'codex',
        status,
        ports: [],
        workspaces: [],
        ...overrides
      }
    ]
  })
}

function inbox(overrides: Record<string, unknown> = {}) {
  return {
    version: 'orca.local-sbx.v1',
    dispatchId: BINDING.dispatchId,
    nonce: NONCE,
    deliveryId: 'delivery_1',
    messages: [
      {
        id: 'message_1',
        type: 'dispatch',
        subject: 'Synthetic task',
        body: BINDING.spec,
        payload: null
      }
    ],
    ...overrides
  }
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    version: 'orca.local-sbx.v1',
    taskId: BINDING.taskId,
    dispatchId: BINDING.dispatchId,
    nonce: NONCE,
    deliveryId: 'delivery_1',
    outcome: 'succeeded',
    summary: 'Synthetic task completed.',
    evidence: ['No host workspace was available.'],
    ...overrides
  }
}

function codexOutput(value = result()): string {
  return `${JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify(value) }
  })}\n`
}

function authority(events: string[], delivery: unknown = inbox()): LocalSbxHostAuthority {
  return {
    acceptDispatch: vi.fn(async () => {
      events.push('authority.accept')
      return BINDING
    }),
    recordReady: vi.fn(async () => {
      events.push('authority.ready')
    }),
    takeOneDelivery: vi.fn(async () => {
      events.push('authority.delivery')
      return delivery
    }),
    settleWorkerDoneAndAcknowledge: vi.fn(async () => {
      events.push('authority.settle-and-ack')
    }),
    failDispatch: vi.fn(async () => {
      events.push('authority.fail')
    }),
    recordOutcomeUnknown: vi.fn(async () => {
      events.push('authority.unknown')
    }),
    closeRunnerTerminal: vi.fn(async () => {
      events.push('authority.close-runner')
    })
  }
}

function successfulAdapter(
  events: string[],
  options: { execution?: LocalSbxCommandResult; stoppedInventory?: string } = {}
): LocalSbxArgvAdapter & {
  calls: readonly string[][]
  inputs: readonly (string | undefined)[]
} {
  const calls: string[][] = []
  const inputs: (string | undefined)[] = []
  let inventoryReads = 0
  return {
    calls,
    inputs,
    run: vi.fn(async (args, runOptions) => {
      calls.push([...args])
      inputs.push(runOptions?.input)
      events.push(`sbx.${args[0]}${args[0] === 'exec' ? `.${args[3]}` : ''}`)
      switch (args[0]) {
        case 'version':
          return success(versionOutput())
        case 'create':
          return success()
        case 'ls':
          inventoryReads += 1
          return success(
            inventoryReads === 1
              ? inventory('running')
              : (options.stoppedInventory ?? inventory('stopped'))
          )
        case 'exec':
          return args[3] === 'tee' ? success() : (options.execution ?? success(codexOutput()))
        case 'stop':
          return success()
        default:
          throw new Error(`Unexpected sbx argv: ${args.join(' ')}`)
      }
    })
  }
}

describe('local-sbx-v1 executor core', () => {
  it('runs one bounded mountless lifecycle and settles only the echoed Delivery', async () => {
    const events: string[] = []
    const host = authority(events)
    const sbx = successfulAdapter(events)

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({
      state: 'succeeded',
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      sandboxName: 'orca-ctx-1',
      release: 'released'
    })
    expect(events.indexOf('authority.accept')).toBeLessThan(events.indexOf('sbx.create'))
    expect(events.indexOf('authority.settle-and-ack')).toBeLessThan(
      events.indexOf('authority.close-runner')
    )
    expect(host.settleWorkerDoneAndAcknowledge).toHaveBeenCalledWith({
      task: expect.objectContaining({ dispatchId: 'ctx_1', nonce: NONCE }),
      result: expect.objectContaining({ deliveryId: 'delivery_1', nonce: NONCE })
    })
    expect(host.takeOneDelivery).toHaveBeenCalledOnce()
    expect(sbx.calls[1]).toEqual([
      'create',
      '--name',
      'orca-ctx-1',
      '--cpus',
      '2',
      '--memory',
      '2g',
      '--skills',
      'off',
      'codex'
    ])
    expect(sbx.calls.at(-2)).toEqual(['stop', 'orca-ctx-1'])
    expect(events.indexOf('sbx.stop')).toBeLessThan(events.lastIndexOf('sbx.ls'))
    expect(events.lastIndexOf('sbx.ls')).toBeLessThan(events.indexOf('authority.close-runner'))

    const schemaInput = sbx.inputs[sbx.calls.findIndex((args) => args[3] === 'tee')]
    expect(JSON.parse(schemaInput ?? '')).toMatchObject({
      type: 'object',
      additionalProperties: false
    })
    const promptInput = sbx.inputs[sbx.calls.findIndex((args) => args[3] === 'codex')]
    expect(promptInput).toContain(`\"deliveryId\":\"delivery_1\"`)
    expect(promptInput).toContain(`\"nonce\":\"${NONCE}\"`)
  })

  it('never plans a shell, host path, environment, cloud, clone, MCP, port, or removal', async () => {
    const events: string[] = []
    const sbx = successfulAdapter(events)
    await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: authority(events), createNonce: () => NONCE }
    )

    const flat = sbx.calls.flat()
    expect(flat).not.toContain('rm')
    expect(flat).not.toContain('sh')
    expect(flat).not.toContain('bash')
    expect(flat).not.toContain('zsh')
    expect(flat).not.toContain('cmd.exe')
    expect(flat).not.toContain('powershell')
    expect(flat).not.toContain('--cloud')
    expect(flat).not.toContain('--clone')
    expect(flat).not.toContain('--env')
    expect(flat).not.toContain('--env-file')
    expect(flat).not.toContain('--publish')
    expect(flat).not.toContain('--static-mcp')
    expect(flat).not.toContain('--volume')
    expect(flat).not.toContain(process.cwd())
    expect(sbx.calls.find((args) => args[0] === 'create')?.at(-1)).toBe('codex')
  })

  it('fails closed before accepting a Dispatch when the backend version is unavailable', async () => {
    const events: string[] = []
    const host = authority(events)
    const sbx: LocalSbxArgvAdapter = {
      run: vi.fn(async () => success(JSON.stringify({ server: { state: 'unavailable' } })))
    }

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({ state: 'failed', stage: 'version', release: 'not_created' })
    expect(host.acceptDispatch).not.toHaveBeenCalled()
  })

  it.each([
    ['nonce', { nonce: 'x'.repeat(32) }],
    ['Delivery', { deliveryId: 'delivery_wrong' }],
    ['Dispatch', { dispatchId: 'ctx_wrong' }]
  ])('retains unknown work when the result echoes the wrong %s identity', async (_label, wrong) => {
    const events: string[] = []
    const host = authority(events)
    const sbx = successfulAdapter(events, { execution: success(codexOutput(result(wrong))) })

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({ state: 'outcome_unknown', stage: 'result_validation' })
    expect(host.settleWorkerDoneAndAcknowledge).not.toHaveBeenCalled()
    expect(host.recordOutcomeUnknown).toHaveBeenCalledOnce()
    expect(host.closeRunnerTerminal).not.toHaveBeenCalled()
    expect(sbx.calls).toContainEqual(['stop', 'orca-ctx-1'])
  })

  it('rejects a sandbox with any host workspace or published port', async () => {
    const events: string[] = []
    const host = authority(events)
    let inventoryReads = 0
    const sbx: LocalSbxArgvAdapter = {
      run: vi.fn(async (args) => {
        if (args[0] === 'version') {
          return success(versionOutput())
        }
        if (args[0] === 'create') {
          return success()
        }
        if (args[0] === 'ls') {
          inventoryReads += 1
          return success(
            inventoryReads === 1
              ? inventory('running', { workspaces: ['/Users/person/repo'], ports: [3000] })
              : inventory('stopped')
          )
        }
        if (args[0] === 'stop') {
          return success()
        }
        throw new Error('Execution must not start after a failed attestation.')
      })
    }

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({ state: 'outcome_unknown', stage: 'ready_inventory' })
    expect(host.takeOneDelivery).not.toHaveBeenCalled()
    expect(host.closeRunnerTerminal).not.toHaveBeenCalled()
  })

  it('does not treat a stopped sandbox as ready to execute', async () => {
    const events: string[] = []
    const host = authority(events)
    const sbx = successfulAdapter(events, { stoppedInventory: inventory('stopped') })
    let inventoryReads = 0
    const originalRun = sbx.run
    sbx.run = vi.fn(async (args, runOptions) => {
      if (args[0] === 'ls') {
        inventoryReads += 1
        if (inventoryReads === 1) {
          return success(inventory('stopped'))
        }
      }
      return originalRun(args, runOptions)
    })

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({ state: 'outcome_unknown', stage: 'ready_inventory' })
    expect(host.takeOneDelivery).not.toHaveBeenCalled()
    expect(host.closeRunnerTerminal).not.toHaveBeenCalled()
  })

  it('records a known create failure only after valid inventory proves no sandbox exists', async () => {
    const events: string[] = []
    const host = authority(events)
    const sbx: LocalSbxArgvAdapter = {
      run: vi.fn(async (args) => {
        if (args[0] === 'version') {
          return success(versionOutput())
        }
        if (args[0] === 'create') {
          return failure('create refused')
        }
        if (args[0] === 'ls') {
          return success(JSON.stringify({ sandboxes: [] }))
        }
        throw new Error('Unexpected command')
      })
    }

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({ state: 'failed', stage: 'create', release: 'released' })
    expect(host.failDispatch).toHaveBeenCalledOnce()
    expect(host.recordOutcomeUnknown).not.toHaveBeenCalled()
    expect(host.closeRunnerTerminal).toHaveBeenCalledWith('ctx_1')
  })

  it('does not close the runner when stop cannot be positively verified', async () => {
    const events: string[] = []
    const host = authority(events)
    const sbx = successfulAdapter(events, {
      stoppedInventory: JSON.stringify({ sandboxes: [] })
    })

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({ state: 'succeeded', release: 'release_unknown' })
    expect(host.settleWorkerDoneAndAcknowledge).toHaveBeenCalledOnce()
    expect(host.closeRunnerTerminal).not.toHaveBeenCalled()
  })

  it('treats malformed inventory after an ambiguous create as unknown, never failed', async () => {
    const events: string[] = []
    const host = authority(events)
    const sbx: LocalSbxArgvAdapter = {
      run: vi.fn(async (args) => {
        if (args[0] === 'version') {
          return success(versionOutput())
        }
        if (args[0] === 'create') {
          return failure('transport closed')
        }
        if (args[0] === 'ls') {
          return success('{malformed')
        }
        if (args[0] === 'stop') {
          return failure('unknown')
        }
        throw new Error('Unexpected command')
      })
    }

    const receipt = await runLocalSbxExecutor(
      { spec: BINDING.spec },
      { sbx, authority: host, createNonce: () => NONCE }
    )

    expect(receipt).toMatchObject({ state: 'outcome_unknown', stage: 'create' })
    expect(host.recordOutcomeUnknown).toHaveBeenCalledOnce()
    expect(host.failDispatch).not.toHaveBeenCalled()
    expect(host.closeRunnerTerminal).not.toHaveBeenCalled()
  })

  it('enforces bounded strict Task, Delivery, and Result contracts', () => {
    expect(
      LocalSbxTaskContract.safeParse({
        version: 'orca.local-sbx.v1',
        ...BINDING,
        nonce: NONCE,
        agent: 'codex',
        spec: 'x'.repeat(32 * 1024 + 1)
      }).success
    ).toBe(false)
    expect(
      LocalSbxInboxContract.safeParse({
        ...inbox(),
        messages: Array.from({ length: 51 }, (_, index) => ({
          id: `message_${index}`,
          type: 'status',
          subject: 'Bound check',
          body: 'Synthetic',
          payload: null
        }))
      }).success
    ).toBe(false)
    expect(LocalSbxResultContract.safeParse({ ...result(), unexpected: true }).success).toBe(false)
  })
})
