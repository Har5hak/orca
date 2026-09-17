import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import type { RuntimeCapability } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'

const mocks = vi.hoisted(() => ({
  resolveProfileAdmission: vi.fn(),
  startLocalWorker: vi.fn()
}))

vi.mock('./worker-start-profile-admission', () => ({
  LAB_PROFILE_REFUSAL_CODE: 'lab_profile_refused',
  resolveWorkerStartProfileAdmission: mocks.resolveProfileAdmission
}))

vi.mock('./local-worker-start', () => ({ startLocalWorker: mocks.startLocalWorker }))

import { ORCHESTRATION_WORKER_START_METHODS } from './workers'

const PROFILE_PARAMS = {
  task: 'task_1',
  from: 'term_coord',
  agent: 'codex',
  profile: 'lab-readonly-supervised-v1',
  adapter: 'codex-workspace-chatgpt-v1',
  worktreeIdentity: 'wt2:local:disposable-instance',
  expectedWorktreePath: '/private/tmp/orca-lab/disposable-worktree'
} as const

const ADMISSION = Object.freeze({
  profile: 'lab-readonly-supervised-v1',
  adapter: 'codex-workspace-chatgpt-v1',
  agent: 'codex',
  maxConcurrency: 1,
  worktreeIdentity: 'wt2:local:disposable-instance',
  worktreeInstanceId: 'disposable-instance',
  expectedWorktreePath: '/private/tmp/orca-lab/disposable-worktree'
})

const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function createRuntime(capabilities: readonly RuntimeCapability[]) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const run = db.createRun({
    objective: 'Prove profile admission boundaries',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const task = {
    ...db.createTask({
      runId: run.id,
      spec: 'Read the disposable checkout.'
    }),
    creator_dispatch_id: null,
    creator_dispatch_run_id: null,
    creator_dispatch_pane_key: null,
    creator_dispatch_process_incarnation: null
  }
  const status = runtime.getStatus()
  vi.spyOn(runtime, 'getStatus').mockReturnValue({ ...status, capabilities: [...capabilities] })
  vi.spyOn(runtime, 'getOrchestrationDb')
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(COORDINATOR_PANE_KEY)
  vi.spyOn(db, 'getCurrentRunForPane')
  vi.spyOn(db, 'getTask').mockReturnValue(task)
  return { db, runtime }
}

async function callWorkerStart(runtime: ReturnType<typeof createRuntime>['runtime'], extra = {}) {
  const method = ORCHESTRATION_WORKER_START_METHODS[0]
  const params = method.params!.parse({ ...PROFILE_PARAMS, ...extra })
  return method.handler(params, { runtime })
}

describe('worker-start profile admission boundary', () => {
  it('runs profile admission before timeout, coordinator, Task, worktree, or provider effects', async () => {
    const { db, runtime } = createRuntime([LAB_READONLY_PROFILE_RUNTIME_CAPABILITY])
    mocks.resolveProfileAdmission.mockImplementationOnce(() => {
      throw new OrchestrationError('lab_profile_refused', 'Profile admission refused.', {
        reason: 'profile_unsupported'
      })
    })

    await expect(
      callWorkerStart(runtime, { timeoutMs: Number.MAX_SAFE_INTEGER })
    ).rejects.toMatchObject({
      code: 'lab_profile_refused',
      data: { reason: 'profile_unsupported' }
    })

    expect(mocks.resolveProfileAdmission).toHaveBeenCalledOnce()
    expect(runtime.getStatus).not.toHaveBeenCalled()
    expect(runtime.getOrchestrationDb).not.toHaveBeenCalled()
    expect(runtime.getTerminalPaneKey).not.toHaveBeenCalled()
    expect(db.getCurrentRunForPane).not.toHaveBeenCalled()
    expect(db.getTask).not.toHaveBeenCalled()
    expect(mocks.startLocalWorker).not.toHaveBeenCalled()
  })

  it('refuses a profile start when this runtime has not advertised the dynamic capability', async () => {
    const { db, runtime } = createRuntime([])
    mocks.resolveProfileAdmission.mockReturnValueOnce(ADMISSION)

    await expect(callWorkerStart(runtime)).rejects.toMatchObject({
      code: 'lab_profile_refused',
      data: { reason: 'profile_capability_unavailable' }
    })

    expect(runtime.getStatus).toHaveBeenCalledOnce()
    expect(runtime.getOrchestrationDb).not.toHaveBeenCalled()
    expect(runtime.getTerminalPaneKey).not.toHaveBeenCalled()
    expect(db.getCurrentRunForPane).not.toHaveBeenCalled()
    expect(db.getTask).not.toHaveBeenCalled()
    expect(mocks.startLocalWorker).not.toHaveBeenCalled()
  })

  it('passes the frozen admission into local start without a mutable worktree selector', async () => {
    const { runtime } = createRuntime([LAB_READONLY_PROFILE_RUNTIME_CAPABILITY])
    mocks.resolveProfileAdmission.mockReturnValueOnce(ADMISSION)
    mocks.startLocalWorker.mockResolvedValueOnce({ state: 'ready' })

    await expect(callWorkerStart(runtime)).resolves.toEqual({ state: 'ready' })

    expect(Object.isFrozen(ADMISSION)).toBe(true)
    expect(mocks.resolveProfileAdmission).toHaveBeenCalledWith(
      expect.objectContaining(PROFILE_PARAMS)
    )
    expect(mocks.startLocalWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        profileAdmission: ADMISSION,
        params: expect.not.objectContaining({ worktree: expect.anything() })
      })
    )
  })
})
