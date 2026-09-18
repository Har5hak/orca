import type { ProcessResult, ProcessSpec } from '../../../../shared/child-process/run-process'
import type {
  CodexLabCommandConfinementControlEvidence,
  CodexLabCommandConfinementProbeReport,
  CodexLabObservedPathIdentity
} from './codex-lab-command-confinement-contract'
import type { CodexLabCommandConfinementTargets } from './codex-lab-command-confinement-preflight'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

export type CodexLabTrustedFileObservation = Readonly<{
  path: string
  observedRealPath: string
  kind: 'regular-file'
  executable: boolean
  identity: CodexLabObservedPathIdentity
  sha256: string
}>

export type CodexLabTrustedLayoutObservation = Readonly<{
  dispatchRootIdentity: CodexLabObservedPathIdentity
  codexHomeIdentity: CodexLabObservedPathIdentity
  fakeHomeIdentity: CodexLabObservedPathIdentity
  configIdentity: CodexLabObservedPathIdentity
  configSha256: string
  authJson: 'absent'
}>

export type CodexLabTrustedControlSession = Readonly<{
  controls: CodexLabCommandConfinementControlEvidence
  assertPostExecution(report: CodexLabCommandConfinementProbeReport): void
  close(): Promise<void>
}>

export type CodexLabExactExecutionResult = Readonly<{
  process: ProcessResult
  processTreeTermination: 'verified'
}>

export type PrepareVerifiedCodexLabLaunchInput = Readonly<{
  plan: SealedCodexLabLaunchPlan
  preparedLayout: PreparedCodexLabRuntimeLayout
}>

export type CodexLabLiveConfinementHost = Readonly<{
  randomNonce(): string
  observeExecutable(path: string): CodexLabTrustedFileObservation
  observeLayout(prepared: PreparedCodexLabRuntimeLayout): CodexLabTrustedLayoutObservation
  openControlSession(
    args: Readonly<{
      plan: SealedCodexLabLaunchPlan
      preparedLayout: PreparedCodexLabRuntimeLayout
      worktreeReadTarget: string
      outsideWriteRoot: string
      runNonce: string
      targets: CodexLabCommandConfinementTargets
    }>
  ): Promise<CodexLabTrustedControlSession>
  executeExact(spec: ProcessSpec): Promise<CodexLabExactExecutionResult>
}>

export type CodexLabHostReadinessReceipt = Readonly<{
  schema: 'orca.codex-lab-host-readiness.v1'
  dispatchId: string
  profile: string
  adapter: string
  worktreeIdentity: string
  worktreePath: string
  codexExecutableSha256: string
  configSha256: string
  probeExecutablePath: string
  probeExecutableSha256: string
  probeSourceSha256: string
  controlsSha256: string
  probeReportSha256: string
  exactSandboxSpecSha256: string
  controlTrust: 'trusted-local-host'
  probeIdentityTrust: 'host-re-attested'
  dispatchChannel: 'exact-unix-socket-permitted'
  arbitraryNetwork: 'denied'
  forbiddenWrites: 'denied'
  worktreeRead: 'verified'
  processTreeTermination: 'verified'
  appServerAttestation: 'required-at-opened-thread-gate'
  receiptSha256: string
}>

export type VerifiedCodexLabLaunchPreparation = Readonly<{
  plan: SealedCodexLabLaunchPlan
  preparedLayout: PreparedCodexLabRuntimeLayout
  receipt: CodexLabHostReadinessReceipt
}>
