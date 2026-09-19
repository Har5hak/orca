import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { OrchestrationDb } from '../../db'
import {
  buildCodexLabLaunchReceipt,
  type CodexLabLaunchReceiptV1
} from '../../lab-profile/codex-lab-launch-receipt'
import type { CodexLabStructuredLaunchBinding } from '../../lab-profile/codex-lab-structured-launch-binding-registry'
import { createLabGatewayPolicyReceipt } from '../../lab-profile/dispatch-gateway-policy'
import { buildLabGatewayServerReceipt } from '../../lab-profile/dispatch-gateway-server-receipt'
import { publicCodexLabGatewayReceipt } from '../../../rpc/methods/orchestration/worker/local-codex-lab-launch-authority'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../../../../shared/protocol-version'
import type {
  CodexLabGatewayPublicReceipt,
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyState
} from './lab-runtime-custody-contract'
import { expectedCodexLabDispatchRuntimeRoot, sha256 } from './lab-runtime-custody-validation'

export const PROFILE_ID = 'lab-readonly-supervised-v1'
export const PROVIDER_ID = 'codex-workspace-chatgpt-v1'
export const SESSION_ID = '11111111-1111-4111-8111-111111111111'
export const TERMINAL_HANDLE = 'structworker_33333333-3333-4333-8333-333333333333'
export const TERMINAL_PANE_KEY = `agent-session-${SESSION_ID}:22222222-2222-4222-8222-222222222222`
export const PROCESS_INCARNATION = `structured:${SESSION_ID}`
const CLEANUP_RESOURCES = ['provider', 'gateway', 'auth', 'layout'] as const

type Harness = Readonly<{
  db: OrchestrationDb
  dispatchId: string
  identity: Readonly<{ dispatchId: string; profileId: string }>
  binding: CodexLabStructuredLaunchBinding
}>

const databases: OrchestrationDb[] = []
const tempRoots: string[] = []

export function cleanupCodexLabCustodyTestHarnesses(): void {
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
}

export function trackDatabase(db: OrchestrationDb): void {
  databases.push(db)
}

export function trackTempRoot(root: string): void {
  tempRoots.push(root)
}

export function createHarness(
  createBinding: (dispatchId: string) => CodexLabStructuredLaunchBinding,
  spec = 'persist Codex lab runtime custody',
  databasePath = ':memory:'
): Harness {
  const db = new OrchestrationDb(databasePath)
  trackDatabase(db)
  const run = db.createRun({
    objective: spec,
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskSpec: spec,
    taskRunId: run.id,
    startOptions: { profile: { id: PROFILE_ID } },
    profileLease: { profileId: PROFILE_ID }
  })
  const dispatchId = started.dispatch.id
  db.recordWorkerStage({
    dispatchId,
    stage: 'lab_runtime_planned',
    effects: [{ kind: 'created_lab_runtime', id: dispatchId }],
    residualResources: [{ kind: 'created_lab_runtime', id: dispatchId }]
  })
  db.prepareStartingWorkerAuthority({
    dispatchId,
    handle: TERMINAL_HANDLE,
    paneKey: TERMINAL_PANE_KEY,
    processIncarnation: PROCESS_INCARNATION,
    worktreeId: 'lab-test-worktree',
    effects: [{ kind: 'created_lab_runtime', id: dispatchId }],
    setupState: 'lab_runtime_planned',
    preserveCreatedLabRuntimeResidual: true
  })
  return {
    db,
    dispatchId,
    identity: Object.freeze({ dispatchId, profileId: PROFILE_ID }),
    binding: createBinding(dispatchId)
  }
}

export function closeTrackedDatabase(db: OrchestrationDb): void {
  const index = databases.indexOf(db)
  if (index !== -1) {
    databases.splice(index, 1)
  }
  db.close()
}

export function providerEvidence(harness: Harness) {
  return Object.freeze({
    ...harness.identity,
    providerId: PROVIDER_ID,
    sessionId: SESSION_ID,
    terminalHandle: TERMINAL_HANDLE,
    terminalPaneKey: TERMINAL_PANE_KEY,
    processIncarnation: PROCESS_INCARNATION
  })
}

export function plan(harness: Harness) {
  return harness.db.planCodexLabRuntimeCustody({
    ...harness.identity,
    runtimeRoot: expectedCodexLabDispatchRuntimeRoot(harness.dispatchId)
  })
}

export function gatewayReceipt(harness: Harness): CodexLabGatewayPublicReceipt {
  const dispatchId = harness.dispatchId
  const dispatch = harness.db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    throw new Error('gateway receipt test requires a Dispatch')
  }
  const endpointIdentity = Object.freeze({
    device: '16777234',
    inode: '9001',
    uid: '501',
    mode: '0600' as const,
    type: 'socket' as const
  })
  const policyReceipt = createLabGatewayPolicyReceipt({
    schemaVersion: 1,
    policyId: 'lgp1_public-policy-receipt',
    credentialSha256: 'a'.repeat(64),
    binding: {
      runId: dispatch.run_id,
      taskId: dispatch.task_id,
      dispatchId,
      terminalHandle: TERMINAL_HANDLE,
      terminalPaneKey: TERMINAL_PANE_KEY
    },
    revoked: false,
    workerDoneAccepted: false,
    terminal: false
  })
  return publicCodexLabGatewayReceipt(
    buildLabGatewayServerReceipt(
      join(expectedCodexLabDispatchRuntimeRoot(dispatchId), 'gateway.sock'),
      PROCESS_INCARNATION,
      'lgp1_public-policy-receipt',
      dispatchId,
      {
        evidence: endpointIdentity,
        identitySha256: sha256(JSON.stringify(endpointIdentity))
      },
      policyReceipt
    )
  )
}

export function launchReceipt(
  harness: Harness,
  custody: CodexLabRuntimeCustody
): CodexLabLaunchReceiptV1 {
  const { binding } = harness
  if (!custody.gatewayReceipt) {
    throw new Error('launch receipt test requires gateway custody')
  }
  const stableHostReadiness = Object.freeze({
    schema: 'orca.codex-lab-host-readiness.v1' as const,
    dispatchId: harness.dispatchId,
    profile: PROFILE_ID,
    adapter: PROVIDER_ID,
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
  return buildCodexLabLaunchReceipt({
    plan: binding.plan,
    worktree: binding.worktree.receipt,
    hostReadiness: Object.freeze({
      ...stableHostReadiness,
      receiptSha256: sha256(JSON.stringify(stableHostReadiness))
    }),
    gateway: custody.gatewayReceipt,
    custody,
    runtime: {
      runtimeId: 'runtime_task_757',
      buildVersion: '1.4.205',
      capabilities: [LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]
    }
  })
}

export function advanceTo(
  harness: Harness,
  target: Exclude<CodexLabRuntimeCustodyState, 'cleanup_pending' | 'released'>
) {
  const { binding } = harness
  let custody = plan(harness)
  if (target === 'planned') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeAuthorityAttached(harness.identity)
  if (target === 'authority_attached') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeLayoutPrepared({
    ...harness.identity,
    runtimeParentIdentity: { device: '1', inode: '2' },
    runtimeRootIdentity: { device: '1', inode: '3' },
    configSha256: binding.plan.receiptInputs.configSha256
  })
  if (target === 'layout_prepared') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeProviderReserved(providerEvidence(harness))
  if (target === 'provider_reserved') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeGatewayStarted({
    ...harness.identity,
    receipt: gatewayReceipt(harness)
  })
  if (target === 'gateway_started') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeExternalAuthInstalled({
    ...harness.identity,
    authMethod: 'chatgptAuthTokens',
    authStorage: 'ephemeral',
    loginStartAccepted: true,
    authJsonAbsent: true
  })
  if (target === 'external_auth_installed') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeProviderAttached(providerEvidence(harness))
  if (target === 'provider_attached') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeLaunchReceipt({
    ...harness.identity,
    receipt: launchReceipt(harness, custody)
  })
  return harness.db.recordCodexLabRuntimeReady(harness.identity)
}

export function proveCreatedResourcesReleased(harness: Harness): void {
  let custody = harness.db.getCodexLabRuntimeCustody(harness.dispatchId)
  if (!custody) {
    throw new Error('missing custody row')
  }
  if (custody.cleanup.provider.state !== 'not_created') {
    const worker = harness.db.getWorkerDispatch(harness.dispatchId)
    if (worker?.state === 'starting') {
      harness.db.failWorkerStart(harness.dispatchId, worker.stage, 'cleanup test settlement')
    }
    const requested = harness.db.requestWorkerTerminalRelease(harness.dispatchId)
    if (requested.disposition === 'requested') {
      harness.db.settleWorkerTerminalRelease(requested.resource.id)
    }
  }
  for (const resource of CLEANUP_RESOURCES) {
    if (custody.cleanup[resource].state !== 'not_created') {
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource,
        outcome: 'released'
      })
    }
    custody = harness.db.getCodexLabRuntimeCustody(harness.dispatchId) ?? custody
  }
}
