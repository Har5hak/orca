import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCliError, reportCliError } from './format'
import { ORCHESTRATION_TASK_HANDLERS } from './handlers/orchestration/task-handlers'
import { RuntimeClient, RuntimeClientError } from './runtime-client'

const RETRY_REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

describe('malformed keyed Task success through the outer CLI error boundary', () => {
  beforeEach(() => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  it.each([
    ['missing receipt', { task: task() }],
    ['invalid disposition', { task: task(), delivery: { ...delivery(), disposition: 'reused' } }],
    [
      'contradictory receipt',
      { task: task(), delivery: { ...delivery(), task_id: 'task_different' } }
    ]
  ])('prints a fail-closed %s in human and JSON modes', async (_case, malformedResult) => {
    const error = await captureMalformedSuccess(malformedResult)
    const context = { commandPath: ['orchestration', 'task-create'] }
    const text = formatCliError(error, context)
    const nextSteps = readNextSteps(error)

    expect(text).toContain('invalid_runtime_response')
    expect(text).toContain('outcome_unknown')
    expect(occurrences(text, RETRY_REQUEST_ID)).toBe(1)
    for (const step of nextSteps) {
      expect(occurrences(text, step)).toBe(1)
    }

    const errorOutput = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportCliError(error, false, context)
    expect(errorOutput).toHaveBeenCalledOnce()
    expect(errorOutput).toHaveBeenCalledWith(text)

    const jsonOutput = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportCliError(error, true, context)
    const printed = JSON.parse(String(jsonOutput.mock.calls[0]?.[0]))
    expect(printed).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_runtime_response',
        data: {
          orchestrationRequestId: RETRY_REQUEST_ID,
          recovery: {
            orchestrationRequestId: RETRY_REQUEST_ID,
            disposition: 'outcome_unknown'
          }
        }
      }
    })
    expect(printed.error.message).toContain('invalid_runtime_response')
    expect(printed.error.message).toContain('outcome_unknown')
    expect(printed.error.data.nextSteps).toEqual(nextSteps)
    expect(new Set(printed.error.data.nextSteps).size).toBe(nextSteps.length)
  })
})

async function captureMalformedSuccess(result: unknown): Promise<RuntimeClientError> {
  const call = vi
    .fn()
    .mockResolvedValueOnce({
      result: { capabilities: ['orchestration.task-delivery-key.v1'] }
    })
    .mockResolvedValueOnce({ result: { identity: { handle: 'term_creator', live: true } } })
    .mockResolvedValueOnce({ result })
  const client = Object.assign(
    new RuntimeClient('/tmp/orca-task-delivery-key-format-test', 1_000, null, null, 'orca'),
    { call }
  )

  try {
    await ORCHESTRATION_TASK_HANDLERS['orchestration task-create']({
      flags: new Map([
        ['spec', 'do atomic work'],
        ['delivery-key', 'backlog:TASK-100:v1'],
        ['retry-request', RETRY_REQUEST_ID]
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })
  } catch (error) {
    if (error instanceof RuntimeClientError) {
      return error
    }
    throw error
  }
  throw new Error('Expected a malformed keyed success to fail closed.')
}

function readNextSteps(error: RuntimeClientError): string[] {
  const data = objectRecord(error.data)
  const nextSteps = data?.nextSteps
  if (!Array.isArray(nextSteps) || !nextSteps.every((step) => typeof step === 'string')) {
    throw new Error('Expected structured mutation recovery next steps.')
  }
  return nextSteps
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function task(): { id: string; status: string; run_id: string } {
  return { id: 'task_existing', status: 'ready', run_id: 'run_winner' }
}

function delivery(): {
  delivery_key: string
  contract_sha256: string
  task_id: string
  run_id: string
  disposition: string
} {
  return {
    delivery_key: 'backlog:TASK-100:v1',
    contract_sha256: 'a'.repeat(64),
    task_id: 'task_existing',
    run_id: 'run_winner',
    disposition: 'adopted'
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guards above establish a non-array object whose fields remain unknown.
  return value as Record<string, unknown>
}
