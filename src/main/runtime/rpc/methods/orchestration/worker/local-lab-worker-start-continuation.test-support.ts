import { join } from 'node:path'
import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import {
  expectedCodexLabDispatchRuntimeRoot,
  sha256
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-validation'
import type {
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyState
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-contract'
import type { CodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import { buildLabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server-receipt'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { publicCodexLabGatewayReceipt } from './local-codex-lab-launch-authority'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import type { LocalLabWorkerContinuationDeps } from './local-lab-worker-start-continuation-contract'
import type { LabWorkerStartAdmission } from './worker-start-profile-admission'

export const PROFILE = 'lab-readonly-supervised-v1'
const WORKTREE_PATH = '/private/tmp/orca-lab/disposable-structured'
export const IDENTITY: StructuredWorkerIdentity = Object.freeze({
  handle: 'structworker_33333333-3333-4333-8333-333333333333',
  sessionId: '11111111-1111-4111-8111-111111111111',
  agent: 'codex',
  paneKey:
    'agent-session-11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  processIncarnation: 'structured:11111111-1111-4111-8111-111111111111',
  worktreeId: 'repo::disposable-structured',
  hostScope: Object.freeze({ kind: 'local', hostId: 'local' })
})

const databases: OrchestrationDb[] = []

export function closeContinuationDatabases(): void {
  for (const db of databases.splice(0)) {
    db.close()
  }
}

export function harness(binding: CodexLabStructuredLaunchBinding) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('runtime_task_757')
  const run = db.createRun({
    objective: 'N=1 lab canary',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 1,
    taskSpec: 'Read the assigned repository and report one finding.',
    taskRunId: run.id,
    runtimeEpoch: 'runtime_task_757',
    startOptions: { profile: { id: PROFILE } },
    profileLease: { profileId: PROFILE }
  })
  const resource = Object.freeze({ kind: 'created_lab_runtime', id: started.dispatch.id })
  const worker = db.recordWorkerStage({
    dispatchId: started.dispatch.id,
    stage: 'lab_runtime_planned',
    effects: [resource],
    residualResources: [resource]
  })
  const admission: LabWorkerStartAdmission = Object.freeze({
    profile: PROFILE,
    adapter: 'codex-workspace-chatgpt-v1',
    agent: 'codex',
    maxConcurrency: 1,
    worktreeIdentity: 'wt2:local:disposable-structured',
    worktreeInstanceId: 'disposable-structured',
    expectedWorktreePath: WORKTREE_PATH
  })
  const prepared: PreparedLocalLabWorkerStart = Object.freeze({
    started: Object.freeze({ ...started, worker }),
    worktree: {
      id: IDENTITY.worktreeId,
      instanceId: 'disposable-structured',
      identity: {
        key: admission.worktreeIdentity,
        executionHostId: 'local',
        instanceId: admission.worktreeInstanceId
      },
      repoId: 'repo',
      path: WORKTREE_PATH,
      head: '1'.repeat(40),
      branch: 'task-757',
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
    },
    observation: binding.worktree,
    admission
  })
  return { db, runtime, run, prepared }
}

export function stubCustodyTransitions(db: OrchestrationDb, events: string[]): void {
  vi.spyOn(db, 'planCodexLabRuntimeCustody').mockImplementation((input) => {
    events.push('custody:planned')
    return custodyFixture(input.dispatchId, 'planned')
  })
  vi.spyOn(db, 'recordCodexLabRuntimeAuthorityAttached').mockImplementation((input) => {
    events.push('custody:authority')
    return custodyFixture(input.dispatchId, 'authority_attached')
  })
  vi.spyOn(db, 'recordCodexLabRuntimeLayoutPrepared').mockImplementation((input) => {
    events.push('custody:layout')
    return custodyFixture(input.dispatchId, 'layout_prepared')
  })
  vi.spyOn(db, 'recordCodexLabRuntimeProviderReserved').mockImplementation((input) => {
    events.push('custody:provider-reserved')
    return custodyFixture(input.dispatchId, 'provider_reserved')
  })
  vi.spyOn(db, 'recordCodexLabRuntimeGatewayStarted').mockImplementation((input) => {
    events.push('custody:gateway')
    return custodyFixture(input.dispatchId, 'gateway_started')
  })
  vi.spyOn(db, 'recordCodexLabRuntimeExternalAuthInstalled').mockImplementation((input) => {
    events.push('custody:auth')
    return custodyFixture(input.dispatchId, 'external_auth_installed')
  })
  vi.spyOn(db, 'recordCodexLabRuntimeProviderAttached').mockImplementation((input) => {
    events.push('custody:provider')
    return custodyFixture(input.dispatchId, 'provider_attached')
  })
  vi.spyOn(db, 'recordCodexLabRuntimeReady').mockImplementation((input) => {
    events.push('custody:ready')
    return custodyFixture(input.dispatchId, 'ready')
  })
}

function custodyFixture(
  dispatchId: string,
  state: CodexLabRuntimeCustodyState
): CodexLabRuntimeCustody {
  const cleanupEntry = Object.freeze({
    state: 'not_created' as const,
    reasonCode: null,
    detailSha256: null
  })
  return Object.freeze({
    dispatchId,
    profileId: PROFILE,
    state,
    runtimeRoot: join('/private/tmp/orca-lab/runtime/dispatches', dispatchId),
    runtimeParentIdentity: null,
    runtimeRootIdentity: null,
    configSha256: null,
    auth: null,
    gatewayReceipt: null,
    provider: null,
    cleanup: Object.freeze({
      layout: cleanupEntry,
      auth: cleanupEntry,
      gateway: cleanupEntry,
      provider: cleanupEntry
    }),
    revision: 0,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z'
  })
}

export function structuredSessionFixture(): Awaited<
  ReturnType<NonNullable<LocalLabWorkerContinuationDeps['createStructuredSession']>>
> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: continuation tests use only the identity and pass the opaque host to a mocked preamble delivery boundary.
  return { identity: IDENTITY, host: {} } as Awaited<
    ReturnType<NonNullable<LocalLabWorkerContinuationDeps['createStructuredSession']>>
  >
}

export function preparedAuthority(
  binding: CodexLabStructuredLaunchBinding,
  rollbackIfUnclaimed: () => Promise<boolean> = vi.fn(async () => true)
) {
  return {
    labLaunchBinding: binding,
    layoutEvidence: {
      dispatchId: binding.dispatchId,
      profileId: PROFILE,
      runtimeParentIdentity: { device: '1', inode: '2' },
      runtimeRootIdentity: { device: '1', inode: '3' },
      configSha256: binding.plan.receiptInputs.configSha256
    },
    gatewayReceipt: {
      schema: 'orca.lab-dispatch-gateway.v1' as const,
      policyId: 'lgp1_test',
      dispatchId: binding.dispatchId,
      transport: 'unix' as const,
      socketMode: '0600' as const,
      endpointSha256: binding.plan.receiptInputs.gatewaySocketPathSha256,
      endpointIdentity: {
        device: '1',
        inode: '4',
        uid: '501',
        mode: '0600' as const,
        type: 'socket' as const
      },
      endpointIdentitySha256: 'a'.repeat(64),
      processIncarnationSha256: 'b'.repeat(64),
      allowedOperations: ['worker.done', 'worker.ask', 'worker.check'] as const,
      lifecycleSource: 'injected-per-request' as const,
      dcapCustody: 'server-only' as const,
      receiptSha256: 'c'.repeat(64)
    },
    rollbackIfUnclaimed,
    releaseCleanupRegistration: vi.fn(() => true)
  }
}

export function returningPreparedAuthority(
  binding: CodexLabStructuredLaunchBinding,
  rollbackIfUnclaimed: () => Promise<boolean> = vi.fn(async () => true)
): LocalLabWorkerContinuationDeps['prepareLaunchAuthority'] {
  return async ({ lifecycle }) => {
    const authority = preparedAuthority(binding, rollbackIfUnclaimed)
    lifecycle.recordLayoutPrepared(authority.layoutEvidence)
    lifecycle.recordProviderReserved()
    lifecycle.recordGatewayStarted(authority.gatewayReceipt)
    return authority
  }
}

export function realPhaseAuthority(
  prepared: PreparedLocalLabWorkerStart,
  binding: CodexLabStructuredLaunchBinding,
  rollbackIfUnclaimed: () => Promise<boolean> = vi.fn(async () => true),
  releaseCleanupRegistration: () => boolean = vi.fn(() => true)
) {
  const dispatchId = prepared.started.dispatch.id
  const socketEvidence = Object.freeze({
    device: '1',
    inode: '4',
    uid: '501',
    mode: '0600' as const,
    type: 'socket' as const
  })
  return {
    ...preparedAuthority(binding, rollbackIfUnclaimed),
    layoutEvidence: {
      dispatchId,
      profileId: PROFILE,
      runtimeParentIdentity: { device: '1', inode: '2' },
      runtimeRootIdentity: { device: '1', inode: '3' },
      configSha256: 'd'.repeat(64)
    },
    gatewayReceipt: publicCodexLabGatewayReceipt(
      buildLabGatewayServerReceipt(
        join(expectedCodexLabDispatchRuntimeRoot(dispatchId), 'gateway.sock'),
        IDENTITY.processIncarnation,
        'lgp1_continuation-test',
        dispatchId,
        {
          evidence: socketEvidence,
          identitySha256: sha256(JSON.stringify(socketEvidence))
        }
      )
    ),
    releaseCleanupRegistration
  }
}

export function layoutRemovalEvidence(dispatchId: string) {
  return Object.freeze({
    evidence: 'identity-fenced-active-layout-revoked',
    quarantinePath: join(
      '/private/tmp/orca-lab/runtime/dispatches',
      `.${dispatchId}.cleanup-quarantine`
    ),
    rootIdentity: Object.freeze({ device: '1', inode: '3' })
  })
}
