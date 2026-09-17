import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../shared/rpc-contract/orchestration-worker-start-params'
import { RuntimeClient } from '../runtime-client'

const client = new RuntimeClient('/tmp/orca-worker-profile-cli-test')
const callMock = vi.spyOn(client, 'call')

const profileFlags = new Map<string, string | boolean>([
  ['task', 'task_1'],
  ['agent', 'codex'],
  ['profile', 'lab-readonly-supervised-v1'],
  ['adapter', 'codex-workspace-chatgpt-v1'],
  ['worktree-identity', 'wt2:local:disposable-instance'],
  ['expected-worktree-path', '/private/tmp/orca-lab/disposable-worktree'],
  ['from', 'term_coord']
])

const invokeWorkerStart = () =>
  ORCHESTRATION_HANDLERS['orchestration worker-start']({
    flags: profileFlags,
    client,
    cwd: '/tmp/repo',
    json: true
  })

describe('orchestration worker-start profile CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  it('forwards the independently supplied lab profile admission contract', async () => {
    callMock
      .mockResolvedValueOnce({
        id: 'status-request',
        ok: true,
        result: { capabilities: [LAB_READONLY_PROFILE_RUNTIME_CAPABILITY] },
        _meta: { runtimeId: 'runtime-test' }
      })
      .mockResolvedValueOnce({
        id: 'worker-start-request',
        ok: true,
        result: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready' },
        _meta: { runtimeId: 'runtime-test' }
      })

    await invokeWorkerStart()

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({
        profile: 'lab-readonly-supervised-v1',
        adapter: 'codex-workspace-chatgpt-v1',
        worktreeIdentity: 'wt2:local:disposable-instance',
        expectedWorktreePath: '/private/tmp/orca-lab/disposable-worktree'
      })
    )
  })

  it('fails before worker-start when an older runtime would strip profile admission', async () => {
    callMock.mockResolvedValueOnce({
      id: 'status-request',
      ok: true,
      result: { capabilities: [] },
      _meta: { runtimeId: 'runtime-test' }
    })

    await expect(invokeWorkerStart()).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledTimes(1)
  })
})
