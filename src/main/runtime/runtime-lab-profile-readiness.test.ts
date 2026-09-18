import { afterEach, describe, expect, it } from 'vitest'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readLocalLabWorkerStartReadiness } from './rpc/methods/orchestration/worker/local-lab-worker-start'
import type { RuntimeLabProfileReadiness } from './runtime-lab-profile-readiness'
import { verifiedCodexLabHostPrerequisiteReceipt } from './orchestration/lab-profile/codex-lab-host-prerequisites.test-support'
import {
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
} from './orchestration/lab-profile/codex-lab-launch-contract'

const PROFILE_ID = LAB_READONLY_SUPERVISED_PROFILE_ID
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
    startOptions: {
      profile: {
        id: PROFILE_ID,
        maxConcurrency: LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
      }
    },
    profileLease: { profileId: PROFILE_ID }
  })
}

function attachOwnedTerminal(db: OrchestrationDb, dispatchId: string, label: string): void {
  db.createWorkerTerminalResourceStatement({
    dispatchId,
    worktreeId: `worktree-profile-${label}`,
    terminalHandle: `term_profile_${label}`,
    paneKey: `tab_profile_${label}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    processIncarnation: `process-profile-${label}`,
    hostScope: 'local',
    ownership: 'owned'
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

  it('advertises below capacity, withdraws at capacity, and readvertises after clean release', () => {
    const { runtime, db } = createHarness()
    installVerifiedHostPrerequisites(runtime)
    expectReadiness(runtime, { ready: true })

    reserveProfile(db, 'first active profile owner')
    expectReadiness(runtime, { ready: true })

    const second = reserveProfile(db, 'second active profile owner')

    expectReadiness(runtime, { ready: false, reason: 'profile_capacity_exhausted' })

    db.failWorkerStart(second.dispatch.id, 'profile_admission', 'clean release')
    expectReadiness(runtime, { ready: true })
  })

  it('counts active owned terminals as occupancy without misclassifying them as cleanup', () => {
    const { runtime, db } = createHarness()
    installVerifiedHostPrerequisites(runtime)

    const first = reserveProfile(db, 'first active terminal owner')
    attachOwnedTerminal(db, first.dispatch.id, 'first')
    db.markWorkerDispatchReady(first.dispatch.id)

    expectReadiness(runtime, { ready: true })

    const second = reserveProfile(db, 'second active terminal owner')
    attachOwnedTerminal(db, second.dispatch.id, 'second')
    db.markWorkerDispatchReady(second.dispatch.id)

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

  it('withdraws both surfaces while owned-terminal cleanup is uncertain', () => {
    const { runtime, db } = createHarness()
    installVerifiedHostPrerequisites(runtime)
    const started = reserveProfile(db, 'uncertain profile terminal owner')
    attachOwnedTerminal(db, started.dispatch.id, 'uncertain')
    db.markWorkerStartUnknown(
      started.dispatch.id,
      'profile_terminal_created',
      'terminal acknowledgement unavailable'
    )

    expectReadiness(runtime, { ready: false, reason: 'profile_cleanup_pending' })
  })
})
