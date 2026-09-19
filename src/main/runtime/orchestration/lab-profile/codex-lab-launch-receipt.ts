import { CODEX_LAB_DYNAMIC_TOOL_BINDINGS } from '../../../codex/codex-lab-dynamic-tool-contract'
import { PROTOCOL_VERSION as DAEMON_PROTOCOL_VERSION } from '../../../daemon/daemon-protocol-version'
import {
  LAB_READONLY_PROFILE_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type {
  CodexLabGatewayPublicReceipt,
  CodexLabRuntimeCustody
} from '../db/lab-runtime-custody/lab-runtime-custody-contract'
import type { CodexLabHostReadinessReceipt } from './codex-lab-command-confinement-live-contract'
import type { CodexLabReceiptInputs, SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { validateCodexLabLaunchReceipt } from './codex-lab-launch-receipt-validation'
import {
  assertSecretFree,
  buildAttestedPolicyContract,
  deepFreeze,
  isSha256,
  requireExactObject,
  sha256
} from './codex-lab-launch-receipt-validation-support'
import { SUPPORTED_CODEX_LAB_RELEASE } from './codex-lab-supported-binary'
import type { LabWorktreeObservationReceipt } from './lab-worktree-observation-contract'

export type CodexLabLaunchReceiptRuntimeEvidence = Readonly<{
  runtimeId: string
  buildVersion: string
  capabilities: readonly string[]
}>

export type CodexLabLaunchReceiptV1 = Readonly<{
  schema: 'orca.codex-lab-launch.v1'
  dispatchId: string
  profile: 'lab-readonly-supervised-v1'
  adapter: 'codex-workspace-chatgpt-v1'
  profilePolicySha256: string
  worktree: LabWorktreeObservationReceipt
  runtime: Readonly<{
    identitySha256: string
    buildVersion: string
    platform: 'darwin'
    architecture: 'arm64'
    runtimeProtocolVersion: number
    daemonProtocolVersion: number
    orchestrationContractVersion: number
  }>
  provider: Readonly<{
    executablePath: string
    releaseVersion: string
    executableSha256: string
    argvSha256: string
  }>
  generatedHome: Readonly<{
    codexHomeSha256: string
    fakeHomeSha256: string
    configSha256: string
    attestedContractSha256: string
    attestedToolContractSha256: string
    environmentNameSetSha256: string
  }>
  authentication: Readonly<{
    method: 'chatgpt'
    status: 'active-workspace'
    capacityPolicy: CodexLabReceiptInputs['capacityPolicy']
    capacityPolicySha256: string
    authJsonAbsent: true
  }>
  hostReadiness: CodexLabHostReadinessReceipt
  structuredAttach: Readonly<{
    appServerAttestation: 'verified'
    providerProcessIncarnationSha256: string
  }>
  gateway: CodexLabGatewayPublicReceipt
  capabilities: Readonly<{
    requested: readonly [typeof LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]
    supported: readonly string[]
    effective: readonly [typeof LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]
  }>
  initialCleanup: CodexLabRuntimeCustody['cleanup']
  receiptSha256: string
}>

export function buildCodexLabLaunchReceipt(input: {
  plan: SealedCodexLabLaunchPlan
  worktree: LabWorktreeObservationReceipt
  hostReadiness: CodexLabHostReadinessReceipt
  gateway: CodexLabGatewayPublicReceipt
  custody: CodexLabRuntimeCustody
  runtime: CodexLabLaunchReceiptRuntimeEvidence
}): CodexLabLaunchReceiptV1 {
  const { plan, custody } = input
  if (
    custody.state !== 'provider_attached' ||
    !custody.auth?.authJsonAbsent ||
    !custody.provider ||
    !custody.gatewayReceipt ||
    custody.dispatchId !== plan.dispatchId ||
    input.gateway.dispatchId !== plan.dispatchId ||
    input.gateway.policyReceipt.binding.dispatchIdSha256 !== sha256(plan.dispatchId) ||
    input.hostReadiness.dispatchId !== plan.dispatchId ||
    input.worktree.worktreeIdentity !== plan.worktreeIdentity ||
    input.worktree.worktreePath !== plan.cwd ||
    input.hostReadiness.worktreePath !== plan.cwd ||
    input.hostReadiness.configSha256 !== plan.receiptInputs.configSha256 ||
    custody.configSha256 !== plan.receiptInputs.configSha256 ||
    input.gateway.processIncarnationSha256 !== custody.provider.processIncarnationSha256 ||
    input.gateway.policyReceipt.binding.terminalHandleSha256 !==
      custody.provider.terminalHandleSha256 ||
    input.gateway.policyReceipt.binding.terminalPaneKeySha256 !==
      custody.provider.terminalPaneKeySha256 ||
    JSON.stringify(input.gateway) !== JSON.stringify(custody.gatewayReceipt)
  ) {
    throw new Error('Codex laboratory launch receipt evidence is incomplete or mismatched.')
  }
  if (Object.values(custody.cleanup).some((entry) => entry.state !== 'pending')) {
    throw new Error('Codex laboratory launch receipt requires initial pending cleanup custody.')
  }
  const supported = Object.freeze([...new Set(input.runtime.capabilities)].sort())
  if (!supported.includes(LAB_READONLY_PROFILE_RUNTIME_CAPABILITY)) {
    throw new Error('Codex laboratory launch receipt requires the advertised profile capability.')
  }
  const attestedPolicyContract = buildAttestedPolicyContract({
    worktreePath: input.worktree.worktreePath,
    configSha256: plan.receiptInputs.configSha256,
    capacityPolicySha256: plan.receiptInputs.capacityPolicySha256
  })
  const stable = deepFreeze({
    schema: 'orca.codex-lab-launch.v1' as const,
    dispatchId: plan.dispatchId,
    profile: plan.profile,
    adapter: plan.adapter,
    profilePolicySha256: sha256(
      JSON.stringify({
        profile: plan.profile,
        adapter: plan.adapter,
        capacityPolicySha256: plan.receiptInputs.capacityPolicySha256,
        attestedPolicyContract
      })
    ),
    worktree: input.worktree,
    runtime: {
      identitySha256: sha256(input.runtime.runtimeId),
      buildVersion: input.runtime.buildVersion,
      platform: 'darwin' as const,
      architecture: 'arm64' as const,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    },
    provider: {
      executablePath: plan.receiptInputs.codexExecutablePath,
      releaseVersion: SUPPORTED_CODEX_LAB_RELEASE.version,
      executableSha256: plan.receiptInputs.codexExecutableSha256,
      argvSha256: plan.receiptInputs.argvSha256
    },
    generatedHome: {
      codexHomeSha256: sha256(plan.runtimePaths.codexHome),
      fakeHomeSha256: sha256(plan.runtimePaths.fakeHome),
      configSha256: plan.receiptInputs.configSha256,
      attestedContractSha256: sha256(JSON.stringify(attestedPolicyContract)),
      attestedToolContractSha256: sha256(JSON.stringify(CODEX_LAB_DYNAMIC_TOOL_BINDINGS)),
      environmentNameSetSha256: sha256(
        JSON.stringify(
          [
            ...new Set([
              ...Object.keys(plan.environment.inherited),
              ...Object.keys(plan.environment.injected)
            ])
          ].sort()
        )
      )
    },
    authentication: {
      method: plan.receiptInputs.loginMethod,
      status: plan.receiptInputs.subscriptionStatus,
      capacityPolicy: plan.receiptInputs.capacityPolicy,
      capacityPolicySha256: plan.receiptInputs.capacityPolicySha256,
      authJsonAbsent: true as const
    },
    hostReadiness: input.hostReadiness,
    structuredAttach: {
      appServerAttestation: 'verified' as const,
      providerProcessIncarnationSha256: custody.provider.processIncarnationSha256
    },
    gateway: input.gateway,
    capabilities: {
      requested: [LAB_READONLY_PROFILE_RUNTIME_CAPABILITY] as const,
      supported,
      effective: [LAB_READONLY_PROFILE_RUNTIME_CAPABILITY] as const
    },
    initialCleanup: custody.cleanup
  })
  const receipt = deepFreeze({ ...stable, receiptSha256: sha256(JSON.stringify(stable)) })
  assertSecretFree(receipt)
  return receipt
}

export function parseCodexLabLaunchReceipt(
  value: unknown,
  dispatchId: string
): CodexLabLaunchReceiptV1 {
  const receipt = requireExactObject(value, 'launch receipt', [
    'schema',
    'dispatchId',
    'profile',
    'adapter',
    'profilePolicySha256',
    'worktree',
    'runtime',
    'provider',
    'generatedHome',
    'authentication',
    'hostReadiness',
    'structuredAttach',
    'gateway',
    'capabilities',
    'initialCleanup',
    'receiptSha256'
  ])
  if (
    receipt.schema !== 'orca.codex-lab-launch.v1' ||
    receipt.dispatchId !== dispatchId ||
    receipt.profile !== 'lab-readonly-supervised-v1' ||
    receipt.adapter !== 'codex-workspace-chatgpt-v1' ||
    !isSha256(receipt.profilePolicySha256) ||
    !isSha256(receipt.receiptSha256)
  ) {
    throw new Error('Codex laboratory launch receipt is malformed.')
  }
  validateCodexLabLaunchReceipt(receipt, dispatchId)
  const { receiptSha256, ...stable } = receipt
  if (receiptSha256 !== sha256(JSON.stringify(stable))) {
    throw new Error('Codex laboratory launch receipt digest is invalid.')
  }
  assertSecretFree(receipt)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every nested field, cross-field binding, digest and forbidden secret shape is checked above.
  return deepFreeze(receipt as CodexLabLaunchReceiptV1)
}
