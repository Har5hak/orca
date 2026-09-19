import { join } from 'node:path'
import { CODEX_LAB_DYNAMIC_TOOL_BINDINGS } from '../../../codex/codex-lab-dynamic-tool-contract'
import { PROTOCOL_VERSION as DAEMON_PROTOCOL_VERSION } from '../../../daemon/daemon-protocol-version'
import {
  LAB_READONLY_PROFILE_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { CODEX_LAB_RUNTIME_ROOT } from './codex-lab-launch-contract'
import { SUPPORTED_CODEX_LAB_RELEASE } from './codex-lab-supported-binary'
import { validateGatewayReceipt } from './codex-lab-launch-receipt-gateway-validation'
import {
  allSha256,
  buildAttestedPolicyContract,
  isCanonicalAbsolutePath,
  isGitObjectId,
  isSafeLabel,
  isSha256,
  requireExactArray,
  requireExactObject,
  sameStrings,
  sha256
} from './codex-lab-launch-receipt-validation-support'

export function validateCodexLabLaunchReceipt(
  receipt: Readonly<Record<string, unknown>>,
  dispatchId: string
): void {
  const worktree = requireExactObject(receipt.worktree, 'worktree receipt', [
    'schema',
    'profile',
    'adapter',
    'worktreeIdentity',
    'worktreePath',
    'repositoryRoot',
    'headCommit',
    'treeHash',
    'clean',
    'digests'
  ])
  const worktreeDigests = requireExactObject(worktree.digests, 'worktree digests', [
    'selectorSha256',
    'worktreeIdentitySha256',
    'worktreePathSha256',
    'repositoryRootSha256',
    'gitCommonDirectorySha256',
    'gitHeadSha256',
    'gitTreeSha256',
    'observationSha256'
  ])
  if (
    worktree.schema !== 'orca.lab-worktree-observation.v1' ||
    worktree.profile !== receipt.profile ||
    worktree.adapter !== receipt.adapter ||
    worktree.clean !== true ||
    !isSafeLabel(worktree.worktreeIdentity) ||
    !isCanonicalAbsolutePath(worktree.worktreePath) ||
    worktree.repositoryRoot !== worktree.worktreePath ||
    !isGitObjectId(worktree.headCommit) ||
    !isGitObjectId(worktree.treeHash) ||
    !allSha256(worktreeDigests) ||
    worktreeDigests.selectorSha256 !== sha256(`identity:${worktree.worktreeIdentity}`) ||
    worktreeDigests.worktreeIdentitySha256 !== sha256(worktree.worktreeIdentity) ||
    worktreeDigests.worktreePathSha256 !== sha256(worktree.worktreePath) ||
    worktreeDigests.repositoryRootSha256 !== sha256(worktree.repositoryRoot) ||
    worktreeDigests.gitHeadSha256 !== sha256(worktree.headCommit) ||
    worktreeDigests.gitTreeSha256 !== sha256(worktree.treeHash)
  ) {
    throw new Error('Codex laboratory launch receipt worktree evidence is malformed.')
  }

  const runtime = requireExactObject(receipt.runtime, 'runtime evidence', [
    'identitySha256',
    'buildVersion',
    'platform',
    'architecture',
    'runtimeProtocolVersion',
    'daemonProtocolVersion',
    'orchestrationContractVersion'
  ])
  if (
    !isSha256(runtime.identitySha256) ||
    !isSafeLabel(runtime.buildVersion) ||
    runtime.platform !== 'darwin' ||
    runtime.architecture !== 'arm64' ||
    runtime.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION ||
    runtime.daemonProtocolVersion !== DAEMON_PROTOCOL_VERSION ||
    runtime.orchestrationContractVersion !== ORCHESTRATION_CONTRACT_VERSION
  ) {
    throw new Error('Codex laboratory launch receipt runtime evidence is malformed.')
  }

  const provider = requireExactObject(receipt.provider, 'provider evidence', [
    'executablePath',
    'releaseVersion',
    'executableSha256',
    'argvSha256'
  ])
  if (
    !isCanonicalAbsolutePath(provider.executablePath) ||
    provider.releaseVersion !== SUPPORTED_CODEX_LAB_RELEASE.version ||
    !isSha256(provider.executableSha256) ||
    !isSha256(provider.argvSha256)
  ) {
    throw new Error('Codex laboratory launch receipt provider evidence is malformed.')
  }

  const generatedHome = requireExactObject(receipt.generatedHome, 'generated home evidence', [
    'codexHomeSha256',
    'fakeHomeSha256',
    'configSha256',
    'attestedContractSha256',
    'attestedToolContractSha256',
    'environmentNameSetSha256'
  ])
  if (!allSha256(generatedHome)) {
    throw new Error('Codex laboratory launch receipt generated home evidence is malformed.')
  }

  const authentication = requireExactObject(receipt.authentication, 'authentication evidence', [
    'method',
    'status',
    'capacityPolicy',
    'capacityPolicySha256',
    'authJsonAbsent'
  ])
  if (
    authentication.method !== 'chatgpt' ||
    authentication.status !== 'active-workspace' ||
    (authentication.capacityPolicy !== 'ordinary-included-only' &&
      authentication.capacityPolicy !== 'authorized-metered-workspace') ||
    !isSha256(authentication.capacityPolicySha256) ||
    authentication.authJsonAbsent !== true
  ) {
    throw new Error('Codex laboratory launch receipt authentication evidence is malformed.')
  }
  const attestedPolicyContract = buildAttestedPolicyContract({
    worktreePath: worktree.worktreePath,
    configSha256: generatedHome.configSha256,
    capacityPolicySha256: authentication.capacityPolicySha256
  })
  if (
    generatedHome.codexHomeSha256 !==
      sha256(join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId, 'codex-home')) ||
    generatedHome.fakeHomeSha256 !==
      sha256(join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId, 'fake-home')) ||
    generatedHome.attestedContractSha256 !== sha256(JSON.stringify(attestedPolicyContract)) ||
    generatedHome.attestedToolContractSha256 !==
      sha256(JSON.stringify(CODEX_LAB_DYNAMIC_TOOL_BINDINGS)) ||
    receipt.profilePolicySha256 !==
      sha256(
        JSON.stringify({
          profile: receipt.profile,
          adapter: receipt.adapter,
          capacityPolicySha256: authentication.capacityPolicySha256,
          attestedPolicyContract
        })
      )
  ) {
    throw new Error('Codex laboratory launch receipt policy evidence is malformed.')
  }

  validateHostReadiness(receipt, dispatchId, worktree, provider, generatedHome)

  const structuredAttach = requireExactObject(
    receipt.structuredAttach,
    'structured attach evidence',
    ['appServerAttestation', 'providerProcessIncarnationSha256']
  )
  if (
    structuredAttach.appServerAttestation !== 'verified' ||
    !isSha256(structuredAttach.providerProcessIncarnationSha256)
  ) {
    throw new Error('Codex laboratory launch receipt structured attach evidence is malformed.')
  }

  const gateway = validateGatewayReceipt(receipt.gateway, dispatchId)
  if (structuredAttach.providerProcessIncarnationSha256 !== gateway.processIncarnationSha256) {
    throw new Error('Codex laboratory launch receipt process identity is mismatched.')
  }

  validateCapabilities(receipt.capabilities)
  validateInitialCleanup(receipt.initialCleanup)
}

function validateHostReadiness(
  receipt: Readonly<Record<string, unknown>>,
  dispatchId: string,
  worktree: Readonly<Record<string, unknown>>,
  provider: Readonly<Record<string, unknown>>,
  generatedHome: Readonly<Record<string, unknown>>
): void {
  const hostReadiness = requireExactObject(receipt.hostReadiness, 'host readiness evidence', [
    'schema',
    'dispatchId',
    'profile',
    'adapter',
    'worktreeIdentity',
    'worktreePath',
    'codexExecutableSha256',
    'configSha256',
    'probeExecutablePath',
    'probeExecutableSha256',
    'probeSourceSha256',
    'controlsSha256',
    'probeReportSha256',
    'exactSandboxSpecSha256',
    'controlTrust',
    'probeIdentityTrust',
    'dispatchChannel',
    'arbitraryNetwork',
    'forbiddenWrites',
    'worktreeRead',
    'processTreeTermination',
    'appServerAttestation',
    'receiptSha256'
  ])
  const { receiptSha256: hostReceiptSha256, ...stableHostReadiness } = hostReadiness
  if (
    hostReadiness.schema !== 'orca.codex-lab-host-readiness.v1' ||
    hostReadiness.dispatchId !== dispatchId ||
    hostReadiness.profile !== receipt.profile ||
    hostReadiness.adapter !== receipt.adapter ||
    hostReadiness.worktreeIdentity !== worktree.worktreeIdentity ||
    hostReadiness.worktreePath !== worktree.worktreePath ||
    hostReadiness.codexExecutableSha256 !== provider.executableSha256 ||
    hostReadiness.configSha256 !== generatedHome.configSha256 ||
    !isCanonicalAbsolutePath(hostReadiness.probeExecutablePath) ||
    !allSha256(stableHostReadiness, [
      'codexExecutableSha256',
      'configSha256',
      'probeExecutableSha256',
      'probeSourceSha256',
      'controlsSha256',
      'probeReportSha256',
      'exactSandboxSpecSha256'
    ]) ||
    hostReadiness.controlTrust !== 'trusted-local-host' ||
    hostReadiness.probeIdentityTrust !== 'host-re-attested' ||
    hostReadiness.dispatchChannel !== 'exact-unix-socket-permitted' ||
    hostReadiness.arbitraryNetwork !== 'denied' ||
    hostReadiness.forbiddenWrites !== 'denied' ||
    hostReadiness.worktreeRead !== 'verified' ||
    hostReadiness.processTreeTermination !== 'verified' ||
    hostReadiness.appServerAttestation !== 'required-at-opened-thread-gate' ||
    !isSha256(hostReceiptSha256) ||
    hostReceiptSha256 !== sha256(JSON.stringify(stableHostReadiness))
  ) {
    throw new Error('Codex laboratory launch receipt host readiness evidence is malformed.')
  }
}

function validateCapabilities(value: unknown): void {
  const capabilities = requireExactObject(value, 'capability evidence', [
    'requested',
    'supported',
    'effective'
  ])
  const requested = requireExactArray(capabilities.requested, 'requested capabilities')
  const supported = requireExactArray(capabilities.supported, 'supported capabilities')
  const effective = requireExactArray(capabilities.effective, 'effective capabilities')
  if (
    !sameStrings(requested, [LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]) ||
    !sameStrings(effective, [LAB_READONLY_PROFILE_RUNTIME_CAPABILITY]) ||
    supported.length === 0 ||
    !supported.every(isSafeLabel) ||
    !sameStrings(supported, [...new Set(supported)].sort()) ||
    !supported.includes(LAB_READONLY_PROFILE_RUNTIME_CAPABILITY)
  ) {
    throw new Error('Codex laboratory launch receipt capability evidence is malformed.')
  }
}

function validateInitialCleanup(value: unknown): void {
  const initialCleanup = requireExactObject(value, 'initial cleanup evidence', [
    'layout',
    'auth',
    'gateway',
    'provider'
  ])
  for (const resource of ['layout', 'auth', 'gateway', 'provider'] as const) {
    const entry = requireExactObject(initialCleanup[resource], `${resource} cleanup evidence`, [
      'state',
      'reasonCode',
      'detailSha256'
    ])
    if (entry.state !== 'pending' || entry.reasonCode !== null || entry.detailSha256 !== null) {
      throw new Error('Codex laboratory launch receipt cleanup evidence is malformed.')
    }
  }
}
