import type {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID
} from '../../lab-profile/codex-lab-launch-contract'
import type { LabGatewayOperation } from '../../lab-profile/dispatch-gateway-policy-contract'
import type { CodexLabLaunchReceiptV1 } from '../../lab-profile/codex-lab-launch-receipt'

export const CODEX_LAB_RUNTIME_CUSTODY_STATES = [
  'planned',
  'authority_attached',
  'layout_prepared',
  'provider_reserved',
  'gateway_started',
  'external_auth_installed',
  'provider_attached',
  'ready',
  'cleanup_pending',
  'released'
] as const

export const CODEX_LAB_RUNTIME_CLEANUP_REASON_CODES = [
  'release_failed',
  'identity_unproven',
  'process_exit_unproven',
  'host_unreachable',
  'resource_busy',
  'unexpected_error'
] as const

export type CodexLabRuntimeCustodyState = (typeof CODEX_LAB_RUNTIME_CUSTODY_STATES)[number]
export type CodexLabRuntimeCleanupResource = 'layout' | 'auth' | 'gateway' | 'provider'
export type CodexLabRuntimeCleanupState =
  | 'not_created'
  | 'pending'
  | 'failed'
  | 'unproven'
  | 'released'
export type CodexLabRuntimeCleanupReasonCode =
  (typeof CODEX_LAB_RUNTIME_CLEANUP_REASON_CODES)[number]

export type CodexLabRuntimePathIdentity = Readonly<{
  device: string
  inode: string
}>

export type CodexLabGatewayPublicReceipt = Readonly<{
  schema: 'orca.lab-dispatch-gateway.v1'
  policyId: string
  dispatchId: string
  transport: 'unix'
  socketMode: '0600'
  endpointSha256: string
  endpointIdentity: Readonly<{
    device: string
    inode: string
    uid: string
    mode: '0600'
    type: 'socket'
  }>
  endpointIdentitySha256: string
  processIncarnationSha256: string
  policyReceipt: Readonly<{
    schema: 'orca.lab-gateway-policy-public.v1'
    policyId: string
    binding: Readonly<{
      runIdSha256: string
      taskIdSha256: string
      dispatchIdSha256: string
      terminalHandleSha256: string
      terminalPaneKeySha256: string
    }>
    allowedOperations: readonly LabGatewayOperation[]
    state: 'active'
    workerDoneAccepted: false
    unwiredBoundaries: readonly string[]
    sourcePolicyDigest: string
    receiptSha256: string
  }>
  allowedOperations: readonly LabGatewayOperation[]
  lifecycleSource: 'injected-per-request'
  receiptSha256: string
}>

export type CodexLabRuntimeCleanupEntry = Readonly<{
  state: CodexLabRuntimeCleanupState
  reasonCode: CodexLabRuntimeCleanupReasonCode | null
  detailSha256: string | null
}>

export type CodexLabRuntimeProviderCommitments = Readonly<{
  id: typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
  sessionSha256: string
  terminalHandleSha256: string
  terminalPaneKeySha256: string
  processIncarnationSha256: string
}>

export type CodexLabRuntimeProviderCustody = CodexLabRuntimeProviderCommitments &
  Readonly<{ terminalResourceId: string }>

export type CodexLabRuntimeCustody = Readonly<{
  dispatchId: string
  profileId: typeof LAB_READONLY_SUPERVISED_PROFILE_ID
  state: CodexLabRuntimeCustodyState
  runtimeRoot: string
  runtimeParentIdentity: CodexLabRuntimePathIdentity | null
  runtimeRootIdentity: CodexLabRuntimePathIdentity | null
  configSha256: string | null
  auth: Readonly<{
    method: 'chatgptAuthTokens'
    storage: 'ephemeral'
    loginStartAccepted: true
    authJsonAbsent: true
  }> | null
  gatewayReceipt: CodexLabGatewayPublicReceipt | null
  launchReceipt: CodexLabLaunchReceiptV1 | null
  provider: CodexLabRuntimeProviderCustody | null
  cleanup: Readonly<Record<CodexLabRuntimeCleanupResource, CodexLabRuntimeCleanupEntry>>
  revision: number
  createdAt: string
  updatedAt: string
}>

export type PlanCodexLabRuntimeCustodyInput = Readonly<{
  dispatchId: string
  profileId: string
  runtimeRoot: string
}>

export type CodexLabRuntimeCustodyIdentity = Readonly<{
  dispatchId: string
  profileId: string
}>

export type CodexLabRuntimeLayoutEvidence = CodexLabRuntimeCustodyIdentity &
  Readonly<{
    runtimeParentIdentity: CodexLabRuntimePathIdentity
    runtimeRootIdentity: CodexLabRuntimePathIdentity
    configSha256: string
  }>

export type CodexLabRuntimeExternalAuthEvidence = CodexLabRuntimeCustodyIdentity &
  Readonly<{
    authMethod: 'chatgptAuthTokens'
    authStorage: 'ephemeral'
    loginStartAccepted: true
    authJsonAbsent: true
  }>

export type CodexLabRuntimeGatewayEvidence = CodexLabRuntimeCustodyIdentity &
  Readonly<{
    receipt: CodexLabGatewayPublicReceipt
  }>

export type CodexLabRuntimeLaunchReceiptEvidence = CodexLabRuntimeCustodyIdentity &
  Readonly<{
    receipt: CodexLabLaunchReceiptV1
  }>

export type CodexLabRuntimeProviderEvidence = CodexLabRuntimeCustodyIdentity &
  Readonly<{
    providerId: typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
    sessionId: string
    terminalHandle: string
    terminalPaneKey: string
    processIncarnation: string
  }>

export type CodexLabRuntimeCleanupResult = CodexLabRuntimeCustodyIdentity &
  Readonly<{
    resource: CodexLabRuntimeCleanupResource
    outcome: 'released' | 'failed' | 'unproven'
    reasonCode?: CodexLabRuntimeCleanupReasonCode
    detailSha256?: string
  }>
