import { join } from 'node:path'
import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import {
  expectedCodexLabDispatchRuntimeRoot,
  sha256
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-validation'
import type { CodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import { buildLabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server-receipt'
import { createLabGatewayPolicyReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-policy'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { publicCodexLabGatewayReceipt } from './local-codex-lab-launch-authority'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import type { LocalLabWorkerContinuationDeps } from './local-lab-worker-start-continuation-contract'
import type { LabWorkerStartAdmission } from './worker-start-profile-admission'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { stubCodexLabGatewayReceipt } from './local-lab-worker-start-continuation-custody.test-support'

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
  const runtimeStatus = runtime.getStatus()
  vi.spyOn(runtime, 'getStatus').mockReturnValue({
    ...runtimeStatus,
    capabilities: [...(runtimeStatus.capabilities ?? []), LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]
  })
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
        executionHostId: 'local' as const,
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
    admission,
    admittedRuntimeCapabilities: Object.freeze([LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]),
    runtimeBuildVersion: '1.4.205'
  })
  return { db, runtime, run, prepared }
}

function stubGatewayReceipt(dispatchId: string) {
  return stubCodexLabGatewayReceipt(dispatchId, IDENTITY)
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
  const stableHostReadiness = Object.freeze({
    schema: 'orca.codex-lab-host-readiness.v1' as const,
    dispatchId: binding.dispatchId,
    profile: PROFILE,
    adapter: 'codex-workspace-chatgpt-v1',
    worktreeIdentity: binding.plan.worktreeIdentity,
    worktreePath: binding.plan.cwd,
    codexExecutableSha256: binding.plan.codexExecutableSha256,
    configSha256: binding.plan.receiptInputs.configSha256,
    probeExecutablePath: '/usr/bin/ruby',
    probeExecutableSha256: 'd'.repeat(64),
    probeSourceSha256: 'e'.repeat(64),
    controlsSha256: 'f'.repeat(64),
    probeReportSha256: '0'.repeat(64),
    exactSandboxSpecSha256: '1'.repeat(64),
    controlTrust: 'trusted-local-host' as const,
    probeIdentityTrust: 'host-re-attested' as const,
    dispatchChannel: 'exact-unix-socket-permitted' as const,
    arbitraryNetwork: 'denied' as const,
    forbiddenWrites: 'denied' as const,
    worktreeRead: 'verified' as const,
    processTreeTermination: 'verified' as const,
    appServerAttestation: 'required-at-opened-thread-gate' as const
  })
  return {
    labLaunchBinding: binding,
    layoutEvidence: {
      dispatchId: binding.dispatchId,
      profileId: PROFILE,
      runtimeParentIdentity: { device: '1', inode: '2' },
      runtimeRootIdentity: { device: '1', inode: '3' },
      configSha256: binding.plan.receiptInputs.configSha256
    },
    gatewayReceipt: stubGatewayReceipt(binding.dispatchId),
    hostReadinessReceipt: Object.freeze({
      ...stableHostReadiness,
      receiptSha256: sha256(JSON.stringify(stableHostReadiness))
    }),
    rollbackIfUnclaimed,
    releaseCleanupRegistration: vi.fn(() => true)
  }
}

export function returningPreparedAuthority(
  binding: CodexLabStructuredLaunchBinding,
  rollbackIfUnclaimed: () => Promise<boolean> = vi.fn(async () => true)
): LocalLabWorkerContinuationDeps['prepareLaunchAuthority'] {
  return async ({ lifecycle, prepared }) => {
    if (binding.dispatchId !== prepared.started.dispatch.id) {
      throw new Error('Continuation test binding does not match the prepared dispatch.')
    }
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
  if (binding.dispatchId !== dispatchId) {
    throw new Error('Continuation test binding does not match the prepared dispatch.')
  }
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
      configSha256: binding.plan.receiptInputs.configSha256
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
        },
        createLabGatewayPolicyReceipt({
          schemaVersion: 1,
          policyId: 'lgp1_continuation-test',
          credentialSha256: 'a'.repeat(64),
          binding: {
            runId: prepared.started.dispatch.run_id,
            taskId: prepared.started.dispatch.task_id,
            dispatchId,
            terminalHandle: IDENTITY.handle,
            terminalPaneKey: IDENTITY.paneKey
          },
          revoked: false,
          workerDoneAccepted: false,
          terminal: false
        })
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
