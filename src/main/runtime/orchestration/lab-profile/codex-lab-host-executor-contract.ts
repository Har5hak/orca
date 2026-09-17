import { createHash } from 'node:crypto'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import {
  DISABLED_CODEX_LAB_FEATURES,
  ENABLED_CODEX_LAB_CONFINEMENT_FEATURES
} from './codex-lab-launch-policy'

export const CODEX_LAB_EXPECTED_TOOL_INVENTORY = ['filesystem.read', 'shell.read-only'] as const

export const CODEX_LAB_ACTUAL_HOST_GAPS = [
  'native-secure-layout-adapter',
  'native-effective-policy-probe',
  'native-filesystem-confinement-probe',
  'native-tool-egress-network-probe',
  'native-workspace-provider-attestation',
  'native-provider-process-spawn',
  'persistent-process-and-cleanup-recovery',
  'database-and-rpc-integration'
] as const

export type CodexLabPathObservation =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'directory' | 'file' | 'other'; mode: number }>

export type CodexLabEffectivePolicyEvidence = Readonly<{
  configSha256: string
  approvalPolicy: 'never'
  permissionProfile: 'orca-lab-readonly-v1'
  webSearch: 'disabled'
  historyPersistence: 'none'
  shellEnvironmentInherit: 'none'
  disabledFeatures: readonly string[]
  enabledFeatures: readonly string[]
  mcpServers: readonly string[]
  hooks: readonly string[]
  toolInventory: readonly string[]
  toolEgress: 'denied'
}>

export type CodexLabEffectivePolicyObservation =
  | Readonly<{ state: 'verified'; evidence: CodexLabEffectivePolicyEvidence }>
  | Readonly<{ state: 'unverified'; reason: string }>

export type CodexLabFilesystemEvidence = Readonly<{
  dispatchRoot: string
  rootMode: number
  configMode: number
  writeScope: 'dispatch-root-only'
  worktreeAccess: 'read-only'
  outsideWriteDenied: true
}>

export type CodexLabNetworkEvidence = Readonly<{
  toolEgress: 'denied' | 'allowed'
  providerTransport: 'workspace-chatgpt-only'
  arbitraryDestinationsDenied: true
}>

export type CodexLabProviderEvidence = Readonly<{
  processId: string
  adapter: string
  loginMethod: 'chatgpt'
  subscriptionStatus: 'active-workspace'
  apiTokenRoute: 'absent'
}>

type BoundaryObservation<T> =
  | Readonly<{ state: 'verified'; evidence: T }>
  | Readonly<{ state: 'unverified'; reason: string }>

export type CodexLabRuntimeObservations = Readonly<{
  filesystem: BoundaryObservation<CodexLabFilesystemEvidence>
  network: BoundaryObservation<CodexLabNetworkEvidence>
  provider: BoundaryObservation<CodexLabProviderEvidence>
}>

export type CodexLabSpawnRequest = Readonly<{
  executable: string
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  shell: false
}>

export type CodexLabEffectivePolicyProbeRequest = Readonly<{
  executable: string
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  configPath: string
  shell: false
  network: false
  providerSession: false
}>

export type CodexLabRuntimeProbeRequest = Readonly<{
  processId: string
  dispatchRoot: string
  configPath: string
  worktreePath: string
}>

export type CodexLabHost = {
  observePath(path: string): Promise<CodexLabPathObservation>
  makeDirectoryExclusive(path: string, mode: number): Promise<void>
  writeFileExclusive(path: string, contents: string, mode: number): Promise<void>
  sha256File(path: string): Promise<string>
  probeEffectivePolicy(
    request: CodexLabEffectivePolicyProbeRequest
  ): Promise<CodexLabEffectivePolicyObservation>
  spawnNoShell(request: CodexLabSpawnRequest): Promise<Readonly<{ processId: string }>>
  probeRuntimeBoundaries(request: CodexLabRuntimeProbeRequest): Promise<CodexLabRuntimeObservations>
  terminateProcess(processId: string): Promise<Readonly<{ evidence: string }>>
  removeTree(path: string): Promise<Readonly<{ evidence: string }>>
}

export type CodexLabHostExecutionStage =
  | 'validate_plan'
  | 'freshness'
  | 'create_layout'
  | 'write_config'
  | 'verify_layout'
  | 'verify_config_digest'
  | 'probe_effective_policy'
  | 'spawn'
  | 'probe_runtime_boundaries'

export type CodexLabHostExecutionReason =
  | 'plan_invalid'
  | 'dispatch_root_not_fresh'
  | 'layout_verification_failed'
  | 'config_digest_mismatch'
  | 'effective_policy_unverified'
  | 'effective_policy_mismatch'
  | 'runtime_observation_unverified'
  | 'runtime_observation_mismatch'
  | 'host_operation_failed'

export type CodexLabRollbackEvidence = Readonly<{
  order: number
  action: 'terminate_process' | 'remove_dispatch_root'
  status: 'succeeded' | 'failed' | 'skipped'
  evidence: string
}>

export type CodexLabHostExecutionResult =
  | Readonly<{
      ok: true
      receipt: Readonly<{
        schemaVersion: 1
        dispatchId: string
        processId: string
        configPath: string
        configSha256: string
        effectivePolicySha256: string
        observations: CodexLabRuntimeObservations
        actualHostGaps: typeof CODEX_LAB_ACTUAL_HOST_GAPS
      }>
      effectivePolicy: CodexLabEffectivePolicyObservation
      rollback: readonly CodexLabRollbackEvidence[]
    }>
  | Readonly<{
      ok: false
      stage: CodexLabHostExecutionStage
      reason: CodexLabHostExecutionReason
      message: string
      effectivePolicy: CodexLabEffectivePolicyObservation
      observations: CodexLabRuntimeObservations
      rollback: readonly CodexLabRollbackEvidence[]
      actualHostGaps: typeof CODEX_LAB_ACTUAL_HOST_GAPS
    }>

export function buildExpectedCodexLabEffectivePolicy(
  plan: SealedCodexLabLaunchPlan
): CodexLabEffectivePolicyObservation {
  return {
    state: 'verified',
    evidence: {
      configSha256: plan.receiptInputs.configSha256,
      approvalPolicy: 'never',
      permissionProfile: 'orca-lab-readonly-v1',
      webSearch: 'disabled',
      historyPersistence: 'none',
      shellEnvironmentInherit: 'none',
      disabledFeatures: DISABLED_CODEX_LAB_FEATURES,
      enabledFeatures: ENABLED_CODEX_LAB_CONFINEMENT_FEATURES,
      mcpServers: [],
      hooks: [],
      toolInventory: CODEX_LAB_EXPECTED_TOOL_INVENTORY,
      toolEgress: 'denied'
    }
  }
}

export function buildExpectedCodexLabRuntimeObservations(
  plan: SealedCodexLabLaunchPlan,
  dispatchRoot: string,
  processId: string
): CodexLabRuntimeObservations {
  return {
    filesystem: {
      state: 'verified',
      evidence: {
        dispatchRoot,
        rootMode: 0o700,
        configMode: 0o600,
        writeScope: 'dispatch-root-only',
        worktreeAccess: 'read-only',
        outsideWriteDenied: true
      }
    },
    network: {
      state: 'verified',
      evidence: {
        toolEgress: 'denied',
        providerTransport: 'workspace-chatgpt-only',
        arbitraryDestinationsDenied: true
      }
    },
    provider: {
      state: 'verified',
      evidence: {
        processId,
        adapter: plan.adapter,
        loginMethod: 'chatgpt',
        subscriptionStatus: 'active-workspace',
        apiTokenRoute: 'absent'
      }
    }
  }
}

export function digestCodexLabEvidence(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
