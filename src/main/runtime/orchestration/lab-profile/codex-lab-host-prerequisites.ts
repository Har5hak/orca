import { createHash, timingSafeEqual } from 'node:crypto'
import type { CodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-contract'
import {
  CODEX_LAB_LIVE_PROBE_EXECUTABLE,
  CODEX_LAB_LIVE_PROBE_SOURCE_SHA256
} from './codex-lab-command-confinement-live-probe'
import { createNativeCodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-native'
import { observeNativeCodexLabExecutable } from './codex-lab-command-confinement-live-native-observation'
import { CODEX_LAB_PERMISSION_PROFILE_ID } from './codex-lab-launch-policy'
import {
  resolveSupportedCodexLabExecutable,
  SUPPORTED_CODEX_LAB_RELEASE,
  type SupportedCodexLabExecutable
} from './codex-lab-supported-binary'

const RECEIPT_SHA256 = /^[a-f0-9]{64}$/u
const issuedReceipts = new WeakMap<object, CodexLabHostPrerequisiteReceipt>()

export type CodexLabHostPrerequisiteReceipt = Readonly<{
  schema: 'orca.codex-lab-host-prerequisites.v1'
  platform: 'darwin'
  architecture: 'arm64'
  implementation: 'native-macos-v1'
  permissionProfile: typeof CODEX_LAB_PERMISSION_PROFILE_ID
  codexReleaseVersion: typeof SUPPORTED_CODEX_LAB_RELEASE.version
  codexExecutablePath: string
  codexExecutableSha256: string
  probeExecutablePath: typeof CODEX_LAB_LIVE_PROBE_EXECUTABLE
  probeExecutableSha256: string
  probeSourceSha256: string
  receiptSha256: string
}>

export type CodexLabHostPrerequisiteVerifierHost = Readonly<{
  platform: NodeJS.Platform
  architecture: string
  resolveExecutable(): SupportedCodexLabExecutable
  observeExecutable: CodexLabLiveConfinementHost['observeExecutable']
  createConfinementHost(): CodexLabLiveConfinementHost
}>

/**
 * Attests only process-wide prerequisites. Dispatch paths, sockets, filesystem controls and
 * process-tree termination remain per-launch proof owned by `prepareVerifiedCodexLabLaunch`.
 */
export function verifyCodexLabHostPrerequisites(
  host: CodexLabHostPrerequisiteVerifierHost = NATIVE_CODEX_LAB_PREREQUISITE_HOST
): CodexLabHostPrerequisiteReceipt {
  if (host.platform !== 'darwin' || host.architecture !== 'arm64') {
    throw new Error('Codex laboratory host prerequisites require Apple Silicon macOS.')
  }
  const executable = host.resolveExecutable()
  const observedCodex = host.observeExecutable(executable.path)
  if (
    observedCodex.path !== executable.path ||
    observedCodex.observedRealPath !== executable.path ||
    !observedCodex.executable ||
    executable.pinnedSha256 !== SUPPORTED_CODEX_LAB_RELEASE.binarySha256 ||
    observedCodex.sha256 !== executable.pinnedSha256
  ) {
    throw new Error('The installed Codex executable does not match the supported laboratory pin.')
  }
  const observedProbe = host.observeExecutable(CODEX_LAB_LIVE_PROBE_EXECUTABLE)
  if (
    observedProbe.path !== CODEX_LAB_LIVE_PROBE_EXECUTABLE ||
    observedProbe.observedRealPath !== CODEX_LAB_LIVE_PROBE_EXECUTABLE ||
    !observedProbe.executable
  ) {
    throw new Error('The trusted Codex laboratory probe runtime is unavailable.')
  }
  assertConfinementHostShape(host.createConfinementHost())
  const stable = Object.freeze({
    schema: 'orca.codex-lab-host-prerequisites.v1' as const,
    platform: 'darwin' as const,
    architecture: 'arm64' as const,
    implementation: 'native-macos-v1' as const,
    permissionProfile: CODEX_LAB_PERMISSION_PROFILE_ID,
    codexReleaseVersion: SUPPORTED_CODEX_LAB_RELEASE.version,
    codexExecutablePath: executable.path,
    codexExecutableSha256: executable.pinnedSha256,
    probeExecutablePath: CODEX_LAB_LIVE_PROBE_EXECUTABLE,
    probeExecutableSha256: observedProbe.sha256,
    probeSourceSha256: CODEX_LAB_LIVE_PROBE_SOURCE_SHA256
  })
  const receipt = Object.freeze({ ...stable, receiptSha256: sha256(JSON.stringify(stable)) })
  issuedReceipts.set(receipt, receipt)
  return receipt
}

export function isValidCodexLabHostPrerequisiteReceipt(
  candidate: unknown
): candidate is CodexLabHostPrerequisiteReceipt {
  if (!candidate || typeof candidate !== 'object') {
    return false
  }
  const receipt = issuedReceipts.get(candidate)
  if (!receipt) {
    return false
  }
  if (!RECEIPT_SHA256.test(receipt.receiptSha256)) {
    return false
  }
  const { receiptSha256, ...stable } = receipt
  const expected = Buffer.from(sha256(JSON.stringify(stable)), 'hex')
  const actual = Buffer.from(receiptSha256, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function assertConfinementHostShape(host: CodexLabLiveConfinementHost): void {
  for (const method of [
    host.randomNonce,
    host.observeExecutable,
    host.observeLayout,
    host.openControlSession,
    host.executeExact
  ]) {
    if (typeof method !== 'function') {
      throw new Error('The native Codex laboratory confinement implementation is incomplete.')
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

const NATIVE_CODEX_LAB_PREREQUISITE_HOST: CodexLabHostPrerequisiteVerifierHost = Object.freeze({
  platform: process.platform,
  architecture: process.arch,
  resolveExecutable: () => resolveSupportedCodexLabExecutable(),
  observeExecutable: observeNativeCodexLabExecutable,
  createConfinementHost: createNativeCodexLabLiveConfinementHost
})
