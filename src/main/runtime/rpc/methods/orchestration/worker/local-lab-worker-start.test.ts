import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCapability } from '../../../../../../shared/protocol-version'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { testCodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import {
  startLocalLabWorker,
  type LocalLabWorkerStartDeps,
  type PreparedLocalLabWorkerStart
} from './local-lab-worker-start'
import type { LabWorkerStartAdmission } from './worker-start-profile-admission'

const PROFILE_ID = 'lab-readonly-supervised-v1'
const WORKTREE_IDENTITY = 'wt2:local:disposable-structured'
const WORKTREE_PATH = '/private/tmp/orca-lab/disposable-structured'
const COORDINATOR_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const ADMISSION: LabWorkerStartAdmission = Object.freeze({
  profile: PROFILE_ID,
  adapter: 'codex-workspace-chatgpt-v1',
  agent: 'codex',
  maxConcurrency: 1,
  worktreeIdentity: WORKTREE_IDENTITY,
  worktreeInstanceId: 'disposable-structured',
  expectedWorktreePath: WORKTREE_PATH
})

const WORKTREE: Worktree = {
  id: 'repo::disposable-structured',
  instanceId: 'disposable-structured',
  identity: {
    key: WORKTREE_IDENTITY,
    executionHostId: 'local',
    instanceId: 'disposable-structured'
  },
  repoId: 'repo',
  path: WORKTREE_PATH,
  head: '1'.repeat(40),
  branch: 'task-757-lab',
  isBare: false,
  isMainWorktree: false,
  displayName: 'disposable-structured',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function createHarness(
  capabilities: readonly RuntimeCapability[] = [LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]
) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const run = db.createRun({
    objective: 'Prove the dark lab start boundary',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const status = runtime.getStatus()
  vi.spyOn(runtime, 'getStatus').mockReturnValue({ ...status, capabilities: [...capabilities] })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(COORDINATOR_PANE_KEY)
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
  vi.spyOn(runtime, 'getNestedWorkerMaxDepth').mockReturnValue(1)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('runtime_task_757')
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('process_coord')
  return { db, runtime, run }
}

function createDeps(
  continuePreparedStart: LocalLabWorkerStartDeps['continuePreparedStart'] = async (prepared) => ({
    dispatchId: prepared.started.dispatch.id
  })
): LocalLabWorkerStartDeps {
  const observation = testCodexLabStructuredLaunchBinding().worktree
  return Object.freeze({
    readReadiness: () => Object.freeze({ ready: true }),
    observeWorktree: vi.fn(async () => Object.freeze({ worktree: WORKTREE, observation })),
    requireStructuredCodex: vi.fn(async () => undefined),
    continuePreparedStart
  })
}

async function start(args: {
  harness: ReturnType<typeof createHarness>
  spec: string
  deps?: LocalLabWorkerStartDeps
}) {
  return startLocalLabWorker({
    params: {
      from: 'term_coord',
      spec: args.spec,
      agent: 'codex',
      profile: PROFILE_ID,
      adapter: ADMISSION.adapter,
      worktreeIdentity: WORKTREE_IDENTITY,
      expectedWorktreePath: WORKTREE_PATH
    },
    runtime: args.harness.runtime,
    db: args.harness.db,
    run: args.harness.run,
    coordinatorPane: COORDINATOR_PANE_KEY,
    admission: ADMISSION,
    ...(args.deps ? { deps: args.deps } : {})
  })
}

function countRows(
  db: OrchestrationDb,
  table: 'tasks' | 'dispatch_contexts' | 'worker_dispatches'
) {
  return db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
}

describe('local lab worker start', () => {
  it('keeps the production route dark before worktree or database effects', async () => {
    const harness = createHarness()
    vi.spyOn(harness.runtime, 'showManagedTerminalWorkspace')

    await expect(start({ harness, spec: 'must remain dark' })).rejects.toMatchObject({
      code: 'lab_profile_refused',
      data: {
        reason: 'profile_runtime_unavailable',
        readiness: 'launch_pipeline_incomplete',
        effectsApplied: false
      }
    })

    expect(harness.runtime.showManagedTerminalWorkspace).not.toHaveBeenCalled()
    expect(countRows(harness.db, 'tasks')).toEqual({ count: 0 })
    expect(countRows(harness.db, 'dispatch_contexts')).toEqual({ count: 0 })
    expect(countRows(harness.db, 'worker_dispatches')).toEqual({ count: 0 })
  })

  it('host-observes and requires structured Codex before reserving the lease and inline Task', async () => {
    const harness = createHarness()
    const events: string[] = []
    const baseDeps = createDeps(async (prepared) => {
      expect(JSON.parse(prepared.started.worker.effects)).toEqual([
        { kind: 'created_lab_runtime', id: prepared.started.dispatch.id }
      ])
      expect(JSON.parse(prepared.started.worker.residual_resources)).toEqual([
        { kind: 'created_lab_runtime', id: prepared.started.dispatch.id }
      ])
      events.push('continue')
      return { dispatchId: prepared.started.dispatch.id }
    })
    const deps: LocalLabWorkerStartDeps = Object.freeze({
      ...baseDeps,
      observeWorktree: async (args) => {
        events.push('observe')
        return baseDeps.observeWorktree(args)
      },
      requireStructuredCodex: async (args) => {
        events.push('structured')
        return baseDeps.requireStructuredCodex(args)
      }
    })
    harness.db.db.exec(`
      CREATE TRIGGER require_profile_lease_before_lab_inline_task
      BEFORE INSERT ON tasks
      WHEN NEW.spec = 'profile inline task'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
          FROM worker_dispatches
          WHERE json_extract(start_options, '$.profile.id') = '${PROFILE_ID}'
            AND state = 'starting'
        ) THEN RAISE(ABORT, 'profile lease was not reserved before Task creation') END;
      END;
    `)

    await expect(start({ harness, spec: 'profile inline task', deps })).resolves.toEqual({
      dispatchId: expect.stringMatching(/^ctx_/)
    })

    expect(events).toEqual(['observe', 'structured', 'continue'])
    expect(baseDeps.observeWorktree).toHaveBeenCalledWith({
      runtime: harness.runtime,
      admission: ADMISSION
    })
    expect(baseDeps.requireStructuredCodex).toHaveBeenCalledWith({
      runtime: harness.runtime,
      worktree: WORKTREE
    })
    const worker = harness.db.db
      .prepare('SELECT state, stage, start_options FROM worker_dispatches')
      .get()
    expect(worker).toMatchObject({ state: 'starting', stage: 'lab_runtime_planned' })
    expect(JSON.parse(String(worker?.start_options))).toMatchObject({
      profile: { id: PROFILE_ID, adapter: ADMISSION.adapter, maxConcurrency: 1 },
      worktree: {
        id: WORKTREE.id,
        selector: `identity:${WORKTREE_IDENTITY}`,
        identity: WORKTREE_IDENTITY,
        path: WORKTREE_PATH
      },
      worktreeObservation: {
        schema: 'orca.lab-worktree-observation.v1',
        worktreeIdentity: WORKTREE_IDENTITY,
        worktreePath: WORKTREE_PATH,
        clean: true
      },
      mode: { requested: 'structured', effective: 'structured' },
      agent: 'codex'
    })
  })

  it('persists deterministic runtime cleanup intent before continuation side effects', async () => {
    const harness = createHarness()
    const deps = createDeps(async (prepared) => {
      const worker = harness.db.getWorkerDispatch(prepared.started.dispatch.id)
      if (!worker) {
        throw new Error('lab worker row was not persisted before continuation')
      }
      expect(worker).toMatchObject({ state: 'starting', stage: 'lab_runtime_planned' })
      expect(JSON.parse(worker.effects)).toEqual([
        { kind: 'created_lab_runtime', id: prepared.started.dispatch.id }
      ])
      expect(JSON.parse(worker.residual_resources)).toEqual([
        { kind: 'created_lab_runtime', id: prepared.started.dispatch.id }
      ])
      throw new Error('host preparation failed before root creation')
    })

    await expect(start({ harness, spec: 'durable cleanup intent', deps })).rejects.toThrow(
      'host preparation failed before root creation'
    )

    const worker = harness.db.db
      .prepare('SELECT state, stage, effects, residual_resources FROM worker_dispatches')
      .get()
    expect(worker).toMatchObject({ state: 'starting', stage: 'lab_runtime_planned' })
    expect(JSON.parse(String(worker?.effects))).toEqual([
      { kind: 'created_lab_runtime', id: expect.stringMatching(/^ctx_/) }
    ])
    expect(JSON.parse(String(worker?.residual_resources))).toEqual([
      { kind: 'created_lab_runtime', id: expect.stringMatching(/^ctx_/) }
    ])
  })

  it('refuses a nested creator before observation or database mutation', async () => {
    const harness = createHarness()
    const deps = createDeps()
    vi.spyOn(harness.db, 'resolveCreatorDepth').mockReturnValue(1)

    await expect(start({ harness, spec: 'nested start', deps })).rejects.toMatchObject({
      code: 'lab_profile_refused',
      data: { reason: 'nested_creator_forbidden', effectsApplied: false }
    })

    expect(deps.observeWorktree).not.toHaveBeenCalled()
    expect(countRows(harness.db, 'tasks')).toEqual({ count: 0 })
    expect(countRows(harness.db, 'worker_dispatches')).toEqual({ count: 0 })
  })

  it.each(['worktree_dirty', 'realpath_mismatch', 'worktree_not_disposable'])(
    'leaves no lifecycle rows when host observation refuses %s',
    async (reason) => {
      const harness = createHarness()
      const baseDeps = createDeps()
      const deps: LocalLabWorkerStartDeps = Object.freeze({
        ...baseDeps,
        observeWorktree: async () => {
          throw new Error(reason)
        }
      })

      await expect(start({ harness, spec: `refused ${reason}`, deps })).rejects.toThrow(reason)
      expect(baseDeps.requireStructuredCodex).not.toHaveBeenCalled()
      expect(countRows(harness.db, 'tasks')).toEqual({ count: 0 })
      expect(countRows(harness.db, 'dispatch_contexts')).toEqual({ count: 0 })
      expect(countRows(harness.db, 'worker_dispatches')).toEqual({ count: 0 })
    }
  )

  it('never downgrades when structured Codex is unavailable', async () => {
    const harness = createHarness()
    const continuation = vi.fn(async (_prepared: PreparedLocalLabWorkerStart) => ({
      state: 'impossible'
    }))
    const baseDeps = createDeps(continuation)
    const deps: LocalLabWorkerStartDeps = Object.freeze({
      ...baseDeps,
      requireStructuredCodex: async () => {
        throw new Error('structured_adapter_unavailable')
      }
    })

    await expect(start({ harness, spec: 'no terminal fallback', deps })).rejects.toThrow(
      'structured_adapter_unavailable'
    )
    expect(continuation).not.toHaveBeenCalled()
    expect(countRows(harness.db, 'tasks')).toEqual({ count: 0 })
    expect(countRows(harness.db, 'worker_dispatches')).toEqual({ count: 0 })
  })

  it('rolls back a competing lease before its inline Task or continuation', async () => {
    const harness = createHarness()
    const winnerDeps = createDeps()
    await start({ harness, spec: 'winning lab task', deps: winnerDeps })

    const loserContinuation = vi.fn(async (_prepared: PreparedLocalLabWorkerStart) => ({
      state: 'impossible'
    }))
    const loserDeps = createDeps(loserContinuation)
    await expect(
      start({ harness, spec: 'losing lab task', deps: loserDeps })
    ).rejects.toMatchObject({
      code: 'lab_profile_refused',
      data: { reason: 'profile_capacity_exhausted' }
    })

    expect(loserContinuation).not.toHaveBeenCalled()
    expect(
      harness.db.db.prepare("SELECT id FROM tasks WHERE spec = 'losing lab task'").get()
    ).toBeUndefined()
    expect(countRows(harness.db, 'worker_dispatches')).toEqual({ count: 1 })
  })
})
