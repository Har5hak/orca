import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.hoisted(() => vi.fn())
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
const printResultMock = vi.hoisted(() => vi.fn())
const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE
const RETRY_REQUEST_ID = '11111111-1111-4111-8111-111111111111'

// Why: isolate flag-to-RPC mapping; printResult only writes output.
vi.mock('../format', () => ({ printResult: printResultMock }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import type { HandlerContext } from '../dispatch'
import { RuntimeClient } from '../runtime-client'

const client = Object.assign(
  new RuntimeClient('/tmp/orca-task-create-cli-test', 1_000, null, null, 'orca'),
  { call: callMock }
)

function context(
  entries: readonly (readonly [string, string | boolean])[],
  json: boolean
): HandlerContext {
  return {
    flags: new Map(entries),
    client,
    cwd: '/tmp/repo',
    json
  }
}

describe('orchestration task-create CLI mapping', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    printResultMock.mockReset()
    process.env.ORCA_TERMINAL_HANDLE = 'term_creator'
  })

  afterEach(() => {
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
  })

  it('passes PowerShell-stripped deps through to the runtime', async () => {
    callMock
      .mockResolvedValueOnce({ result: { identity: { handle: 'term_creator', live: true } } })
      .mockResolvedValueOnce({ result: { task: { id: 'task_2', status: 'pending' } } })

    await ORCHESTRATION_HANDLERS['orchestration task-create'](
      context(
        [
          ['spec', 'do child work'],
          ['deps', '[task_b2a580db74d8]']
        ],
        true
      )
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'orchestration.taskCreate', {
      spec: 'do child work',
      taskTitle: undefined,
      displayName: undefined,
      deps: '[task_b2a580db74d8]',
      parent: undefined,
      run: undefined,
      callerTerminalHandle: 'term_creator'
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('refuses a delivery key before resolving identity when the host lacks support', async () => {
    callMock.mockResolvedValueOnce({ result: { capabilities: [] } })

    await expect(
      ORCHESTRATION_HANDLERS['orchestration task-create'](
        context(
          [
            ['spec', 'do atomic work'],
            ['delivery-key', 'backlog:TASK-100:v1']
          ],
          true
        )
      )
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })

    expect(callMock).toHaveBeenCalledOnce()
    expect(callMock).toHaveBeenCalledWith('status.get')
  })

  it.each([
    ['empty', ''],
    ['valueless', true]
  ])(
    'refuses a %s delivery key instead of silently creating an unkeyed Task',
    async (_case, key) => {
      await expect(
        ORCHESTRATION_HANDLERS['orchestration task-create'](
          context(
            [
              ['spec', 'do atomic work'],
              ['delivery-key', key]
            ],
            true
          )
        )
      ).rejects.toMatchObject({ code: 'invalid_argument' })

      expect(callMock).not.toHaveBeenCalled()
    }
  )

  it('routes delivery keys through the additive RPC and makes first-Run adoption explicit', async () => {
    callMock
      .mockResolvedValueOnce({
        result: { capabilities: ['orchestration.task-delivery-key.v1'] }
      })
      .mockResolvedValueOnce({ result: { identity: { handle: 'term_creator', live: true } } })
      .mockResolvedValueOnce({
        result: {
          task: { id: 'task_existing', status: 'ready', run_id: 'run_winner' },
          delivery: {
            delivery_key: 'backlog:TASK-100:v1',
            contract_sha256: 'a'.repeat(64),
            task_id: 'task_existing',
            run_id: 'run_winner',
            disposition: 'adopted'
          }
        }
      })

    await ORCHESTRATION_HANDLERS['orchestration task-create'](
      context(
        [
          ['spec', 'do atomic work'],
          ['delivery-key', 'backlog:TASK-100:v1']
        ],
        false
      )
    )

    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'orchestration.taskCreateByDeliveryKey',
      {
        spec: 'do atomic work',
        taskTitle: undefined,
        displayName: undefined,
        deps: undefined,
        parent: undefined,
        run: undefined,
        callerTerminalHandle: 'term_creator',
        deliveryKey: 'backlog:TASK-100:v1'
      },
      { orchestrationRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/) }
    )
    const formatter = printResultMock.mock.calls[0]?.[2]
    expect(
      formatter?.({
        task: { id: 'task_existing', status: 'ready', run_id: 'run_winner' },
        delivery: {
          delivery_key: 'backlog:TASK-100:v1',
          contract_sha256: 'a'.repeat(64),
          task_id: 'task_existing',
          run_id: 'run_winner',
          disposition: 'adopted'
        }
      })
    ).toBe('Adopted task_existing [ready] in existing Run run_winner')
  })

  it.each([false, true])(
    'marks a keyed success with no delivery receipt outcome-unknown (json=%s)',
    async (json) => {
      await expectMalformedKeyedSuccess(
        { task: { id: 'task_existing', status: 'ready', run_id: 'run_winner' } },
        json
      )
    }
  )

  it.each([false, true])(
    'marks an invalid delivery disposition outcome-unknown (json=%s)',
    async (json) => {
      await expectMalformedKeyedSuccess(
        {
          task: { id: 'task_existing', status: 'ready', run_id: 'run_winner' },
          delivery: {
            delivery_key: 'backlog:TASK-100:v1',
            contract_sha256: 'a'.repeat(64),
            task_id: 'task_existing',
            run_id: 'run_winner',
            disposition: 'reused'
          }
        },
        json
      )
    }
  )

  it.each([false, true])(
    'marks every contradictory delivery receipt field outcome-unknown (json=%s)',
    async (json) => {
      const validDelivery = {
        delivery_key: 'backlog:TASK-100:v1',
        contract_sha256: 'a'.repeat(64),
        task_id: 'task_existing',
        run_id: 'run_winner',
        disposition: 'adopted'
      }
      const contradictions = [
        { ...validDelivery, delivery_key: 'backlog:TASK-DIFFERENT:v1' },
        { ...validDelivery, contract_sha256: 'not-a-sha256' },
        { ...validDelivery, task_id: 'task_different' },
        { ...validDelivery, run_id: 'run_different' }
      ]
      for (const delivery of contradictions) {
        await expectMalformedKeyedSuccess(
          {
            task: { id: 'task_existing', status: 'ready', run_id: 'run_winner' },
            delivery
          },
          json
        )
      }
    }
  )
})

async function expectMalformedKeyedSuccess(result: unknown, json: boolean): Promise<void> {
  callMock.mockReset()
  printResultMock.mockReset()
  callMock
    .mockResolvedValueOnce({
      result: { capabilities: ['orchestration.task-delivery-key.v1'] }
    })
    .mockResolvedValueOnce({ result: { identity: { handle: 'term_creator', live: true } } })
    .mockResolvedValueOnce({ result })

  await expect(
    ORCHESTRATION_HANDLERS['orchestration task-create'](
      context(
        [
          ['spec', 'do atomic work'],
          ['delivery-key', 'backlog:TASK-100:v1'],
          ['retry-request', RETRY_REQUEST_ID]
        ],
        json
      )
    )
  ).rejects.toMatchObject({
    code: 'invalid_runtime_response',
    data: {
      orchestrationRequestId: RETRY_REQUEST_ID,
      recovery: {
        orchestrationRequestId: RETRY_REQUEST_ID,
        disposition: 'outcome_unknown'
      }
    }
  })
  expect(callMock).toHaveBeenNthCalledWith(
    3,
    'orchestration.taskCreateByDeliveryKey',
    expect.any(Object),
    { orchestrationRequestId: RETRY_REQUEST_ID }
  )
  expect(printResultMock).not.toHaveBeenCalled()
}
