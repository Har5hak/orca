import { afterEach, describe, expect, it } from 'vitest'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readLocalLabWorkerStartReadiness } from './rpc/methods/orchestration/worker/local-lab-worker-start'
import type { RuntimeLabProfileReadiness } from './runtime-lab-profile-readiness'
import { verifiedCodexLabHostPrerequisiteReceipt } from './orchestration/lab-profile/codex-lab-host-prerequisites.test-support'

const PROFILE_ID = 'lab-readonly-supervised-v1'
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function createHarness() {
  const runtime = new OrcaRuntimeService()
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  runtime.setOrchestrationDb(db)
  return { runtime, db }
}

function expectReadiness(runtime: OrcaRuntimeService, expected: RuntimeLabProfileReadiness): void {
  const readiness = readLocalLabWorkerStartReadiness(runtime)
  const advertised = runtime
    .getStatus()
    .capabilities?.includes(LAB_READONLY_PROFILE_RUNTIME_CAPABILITY)

  expect(readiness).toEqual(expected)
  expect(advertised).toBe(readiness.ready)
}

function installVerifiedHostPrerequisites(runtime: OrcaRuntimeService): void {
  runtime.installLabProfileHostPrerequisites(verifiedCodexLabHostPrerequisiteReceipt())
}

function reserveProfile(db: OrchestrationDb, taskSpec: string) {
  return db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskSpec,
    taskRunId: 'run_legacy_local',
    startOptions: { profile: { id: PROFILE_ID } },
    profileLease: { profileId: PROFILE_ID }
  })
}

describe('runtime lab-profile readiness', () => {
  it('advertises before any Dispatch only after verified process-wide host prerequisites', () => {
    const { runtime } = createHarness()

    expectReadiness(runtime, { ready: false, reason: 'launch_pipeline_incomplete' })

    installVerifiedHostPrerequisites(runtime)

    expectReadiness(runtime, { ready: true })
  })

  it('stays dark when host verification cannot consult orchestration state', () => {
    const runtime = new OrcaRuntimeService()

    installVerifiedHostPrerequisites(runtime)

    expectReadiness(runtime, { ready: false, reason: 'orchestration_state_unavailable' })
  })

  it('refuses a structurally copied prerequisite receipt', () => {
    const { runtime } = createHarness()
    const receipt = verifiedCodexLabHostPrerequisiteReceipt()

    expect(() => runtime.installLabProfileHostPrerequisites({ ...receipt })).toThrow(
      'Refusing an unverified Codex laboratory host prerequisite receipt'
    )
    expectReadiness(runtime, { ready: false, reason: 'launch_pipeline_incomplete' })
  })

  it('withdraws both surfaces while the profile lease is occupied', () => {
    const { runtime, db } = createHarness()
    installVerifiedHostPrerequisites(runtime)
    reserveProfile(db, 'active profile owner')

    expectReadiness(runtime, { ready: false, reason: 'profile_capacity_exhausted' })
  })

  it('withdraws both surfaces while a settled profile has residual resources', () => {
    const { runtime, db } = createHarness()
    installVerifiedHostPrerequisites(runtime)
    const started = reserveProfile(db, 'profile residue owner')
    db.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'lab_runtime_planned',
      effects: [{ kind: 'created_lab_runtime', id: started.dispatch.id }],
      residualResources: [{ kind: 'created_lab_runtime', id: started.dispatch.id }]
    })
    db.failWorkerStart(started.dispatch.id, 'lab_runtime_planned', 'injected failure')

    expectReadiness(runtime, { ready: false, reason: 'profile_cleanup_pending' })
  })

  it('withdraws both surfaces while terminal cleanup is pending', () => {
    const { runtime, db } = createHarness()
    installVerifiedHostPrerequisites(runtime)
    const started = reserveProfile(db, 'profile terminal owner')
    db.createWorkerTerminalResourceStatement({
      dispatchId: started.dispatch.id,
      worktreeId: 'worktree-profile',
      terminalHandle: 'term_profile',
      paneKey: 'tab_profile:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'process-profile',
      hostScope: 'local',
      ownership: 'owned'
    })
    db.failWorkerStart(started.dispatch.id, 'profile_terminal_created', 'injected failure')

    expectReadiness(runtime, { ready: false, reason: 'profile_cleanup_pending' })
  })
})
