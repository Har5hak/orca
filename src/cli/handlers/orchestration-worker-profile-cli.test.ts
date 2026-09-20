import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'

const client = new RuntimeClient('/tmp/orca-profile-cli-test')
const callMock = vi.spyOn(client, 'call')

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_WORKER_EXECUTION_PROFILE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { ORCHESTRATION_HANDLERS } from './orchestration'

const invokeWorkerStart = (flags: Map<string, string | boolean>) =>
  ORCHESTRATION_HANDLERS['orchestration worker-start']({
    flags,
    client,
    cwd: '/tmp/repo',
    json: true
  })

describe('orchestration worker execution-profile CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  it('capability-gates and forwards a worker execution profile', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'status-1',
        ok: true,
        result: { capabilities: [ORCHESTRATION_WORKER_EXECUTION_PROFILE_RUNTIME_CAPABILITY] },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'worker-1',
        ok: true,
        result: {
          runId: 'run_1',
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          state: 'ready',
          effects: [],
          residualResources: []
        },
        _meta: { runtimeId: 'runtime-1' }
      })

    await invokeWorkerStart(
      new Map([
        ['task', 'task_1'],
        ['profile', 'structured-write-v1'],
        ['agent', 'codex'],
        ['worktree', 'new-child'],
        ['name', 'canary'],
        ['setup', 'skip'],
        ['from', 'term_coord']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({ profile: 'structured-write-v1' })
    )
  })

  it('refuses a profile before RPC when an older runtime would strip it', async () => {
    callMock.mockResolvedValueOnce({
      id: 'status-1',
      ok: true,
      result: { capabilities: [] },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(
      invokeWorkerStart(
        new Map([
          ['task', 'task_1'],
          ['profile', 'structured-write-v1'],
          ['from', 'term_coord']
        ])
      )
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledTimes(1)
  })
})
