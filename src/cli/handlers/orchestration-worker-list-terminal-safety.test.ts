import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { printResult } from '../format'
import { ORCHESTRATION_WORKER_TERMINAL_HANDLERS } from './orchestration/worker-terminal-handlers'

describe('orchestration worker-list terminal-safe output', () => {
  const call = vi.fn()

  beforeEach(() => {
    call.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('strips terminal controls from plain provider labels while preserving JSON data', async () => {
    const run = 'run\nforged\u001b[31m'
    const cursor = 'cursor\nforged\u001b]0;spoof\u0007'
    const countState = 'active\nforged\u202e'
    const provider = {
      id: 'future\u001b]0;spoof\u0007-provider\u202e',
      model: 'model\nspoof'
    }
    const response = {
      result: {
        workers: [
          {
            dispatchId: 'ctx_safe',
            taskId: 'task_safe',
            runId: 'run_1',
            workerState: 'ready',
            dispatchStatus: 'dispatched',
            agentTerminalHandle: 'term_safe',
            terminalState: 'active',
            resource: null,
            projection: {
              provider,
              host: { id: 'environment\u001b[31m-windows' },
              workspace: { id: 'workspace\nspoof' },
              stage: { activity: 'working' },
              liveness: { verdict: 'live' },
              nextAction: { argv: [] },
              attention: { categories: [] }
            }
          }
        ],
        counts: { [countState]: 1 },
        page: { total: 1, hasMore: true, nextCursor: cursor },
        partialHostErrors: [
          {
            environmentId: 'environment_windows',
            name: 'Windows\nforged warning',
            code: 'host_unavailable',
            dispatchIds: ['ctx_safe']
          }
        ]
      }
    }
    call.mockResolvedValue(response)
    const invoke = (json: boolean) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The handler fixture supplies every field this command reads.
      ORCHESTRATION_WORKER_TERMINAL_HANDLERS['orchestration worker-list']({
        flags: new Map([['run', run]]),
        client: { call },
        cwd: '/tmp/repo',
        json
      } as never)

    await invoke(false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: printResult's third argument is the worker-list formatter installed by the handler.
    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: (typeof response)['result']) => string)
      | undefined
    const output = formatter?.(response.result) ?? ''
    expect(output).toContain('provider=future]0;spoof-provider/modelspoof')
    expect(output).toContain('host=environment[31m-windows workspace=workspacespoof')
    expect(output).toContain('worker observations from Windowsforged warning')
    expect(output).toContain('Terminals: activeforged=1')
    expect(output).toContain('Scope: Run runforged[31m (--run)')
    expect(output).toContain('More: --cursor cursorforged]0;spoof')
    expect(output).not.toContain('\u001b')
    expect(output).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u)

    vi.mocked(printResult).mockClear()
    await invoke(true)
    expect(vi.mocked(printResult).mock.calls[0]?.[0]).toMatchObject({
      result: {
        workers: [
          {
            projection: {
              provider,
              host: { id: 'environment\u001b[31m-windows' },
              workspace: { id: 'workspace\nspoof' }
            }
          }
        ],
        counts: { [countState]: 1 },
        page: { nextCursor: cursor },
        scope: { run, source: 'flag' },
        partialHostErrors: [{ name: 'Windows\nforged warning' }]
      }
    })
  })
})
