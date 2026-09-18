import type { ProcessResult, ProcessSpec } from '../../../../shared/child-process/run-process'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

export const CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION = 1 as const
export const CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS = 10_000 as const
export const CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES = 32 * 1024
export const CODEX_LAB_COMMAND_CONFINEMENT_REFUSAL_CODE =
  'ORCA_CODEX_LAB_COMMAND_CONFINEMENT_REFUSED' as const
export const CODEX_LAB_COMMAND_CONFINEMENT_REMAINING_GATES = Object.freeze([
  'strict-config-effective-policy-proof',
  'trusted-control-collector-and-live-listener-custody',
  'trusted-packaged-probe-hash',
  'probe-identity-re-attestation',
  'verified-process-tree-termination'
] as const)

export type CodexLabProbeIdentityCandidate = Readonly<{
  path: string
  argvPrefix: readonly string[]
  observedRealPath: string
  kind: 'regular-file'
  executable: true
  expectedSha256Candidate: string
  observedSha256: string
  device: string
  inode: string
}>
export type CodexLabObservedPathIdentity = Readonly<{ device: string; inode: string }>
export type CodexLabObservedDirectory = Readonly<{
  path: string
  observedRealPath: string
  kind: 'directory'
  custody: 'trusted-local-host'
  identity: CodexLabObservedPathIdentity
}>
type Succeeded<K extends string> = Readonly<Record<K, 'succeeded'>>
type WriteTarget = 'worktree' | 'codexHome' | 'fakeHome' | 'privateTmp' | 'outsideRoot'
type DeniedWriteTarget = Exclude<WriteTarget, 'worktree'>
export type CodexLabReadControlEvidence = Readonly<{
  operation: 'open-read-hash'
  target: string
  observedRealPath: string
  kind: 'regular-file'
  identity: CodexLabObservedPathIdentity
  sha256: string
  result: 'succeeded'
}>
export type CodexLabFreshWriteControlEvidence = Readonly<{
  operation: 'exclusive-create-write-read-unlink'
  parent: CodexLabObservedDirectory
  target: string
  targetBefore: 'absent'
  payloadSha256: string
  targetAfter: 'absent'
}> &
  Succeeded<'exclusiveCreate' | 'readBack' | 'unlink'>
export type CodexLabLiveConnectControlEvidence = Readonly<{
  listener: 'confirmed-live'
  challengeToken: string
  challengeSha256: string
}> &
  Succeeded<'connect' | 'challengeExchange'>
export type CodexLabTcpConnectControlEvidence = CodexLabLiveConnectControlEvidence &
  Readonly<{ host: '127.0.0.1'; port: number }>
export type CodexLabUnixConnectControlEvidence = CodexLabLiveConnectControlEvidence &
  Readonly<{ path: string }>
export type CodexLabTcpBindControlEvidence = Readonly<{ host: '127.0.0.1'; port: 0 }> &
  Succeeded<'bind' | 'listen' | 'close'>
export type CodexLabUnixBindControlEvidence = Readonly<{
  operation: 'bind-listen-close-unlink'
  parent: CodexLabObservedDirectory
  path: string
  targetBefore: 'absent'
  targetAfter: 'absent'
}> &
  Succeeded<'bind' | 'listen' | 'close' | 'unlink'>
export type CodexLabCommandConfinementControlEvidence = Readonly<{
  phase: 'completed-before-sandbox'
  worktreeRead: CodexLabReadControlEvidence
  writes: Readonly<Record<WriteTarget, CodexLabFreshWriteControlEvidence>>
  network: Readonly<{
    tcpConnect: CodexLabTcpConnectControlEvidence
    tcpBind: CodexLabTcpBindControlEvidence
    unixConnect: CodexLabUnixConnectControlEvidence
    unixConnectDenied: CodexLabUnixConnectControlEvidence
    unixBind: CodexLabUnixBindControlEvidence
  }>
}>
export type CodexLabCommandConfinementPreflightInput = Readonly<{
  plan: SealedCodexLabLaunchPlan
  preparedLayout: PreparedCodexLabRuntimeLayout
  probeIdentityCandidate: CodexLabProbeIdentityCandidate
  runNonce: string
  controls: CodexLabCommandConfinementControlEvidence
}>
export type CodexLabCommandConfinementExecutor = (spec: ProcessSpec) => Promise<ProcessResult>

type Denial<S extends string> = Readonly<{
  syscall: S
  result: 'denied-by-sandbox'
  errno: 'EPERM'
}>
export type CodexLabSandboxDeniedWriteEvidence = Readonly<{ root: string; target: string }> &
  Denial<'open(O_CREAT|O_EXCL|O_WRONLY)'>
export type CodexLabSandboxPermittedUnixConnectEvidence = Readonly<{
  path: string
  challengeSha256: string
  syscall: 'connect(AF_UNIX,SOCK_STREAM)'
  result: 'succeeded'
}>
export type CodexLabCommandConfinementProbeReport = Readonly<{
  schemaVersion: typeof CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION
  probe: Readonly<{
    path: string
    sha256: string
    device: string
    inode: string
    identityTrust: 'candidate-only'
  }>
  layout: Readonly<{
    dispatchId: string
    dispatchRoot: string
    dispatchRootIdentity: CodexLabObservedPathIdentity
    codexHomeIdentity: CodexLabObservedPathIdentity
    fakeHomeIdentity: CodexLabObservedPathIdentity
    configIdentity: CodexLabObservedPathIdentity
    configSha256: string
  }>
  worktree: Readonly<{
    identity: string
    path: string
    read: Readonly<{
      target: string
      sha256: string
      syscall: 'open(O_RDONLY)'
      result: 'succeeded'
    }>
    write: CodexLabSandboxDeniedWriteEvidence
  }>
  writes: Readonly<Record<DeniedWriteTarget, CodexLabSandboxDeniedWriteEvidence>>
  network: Readonly<{
    tcpConnect: Readonly<{ host: '127.0.0.1'; port: number; challengeSha256: string }> &
      Denial<'connect(AF_INET,SOCK_STREAM)'>
    tcpBind: Readonly<{ host: '127.0.0.1'; port: 0 }> & Denial<'bind(AF_INET,SOCK_STREAM)'>
    unixConnect: CodexLabSandboxPermittedUnixConnectEvidence
    unixConnectDenied: Readonly<{ path: string; challengeSha256: string }> &
      Denial<'connect(AF_UNIX,SOCK_STREAM)'>
    unixBind: Readonly<{ path: string }> & Denial<'bind(AF_UNIX,SOCK_STREAM)'>
  }>
}>
export type CodexLabCommandConfinementCandidate = Readonly<{
  state: 'candidate-unverified'
  readiness: 'blocked'
  controlTrust: 'caller-asserted-untrusted'
  controls: CodexLabCommandConfinementControlEvidence
  probeReport: CodexLabCommandConfinementProbeReport
  remainingGates: typeof CODEX_LAB_COMMAND_CONFINEMENT_REMAINING_GATES
}>
export type CodexLabCommandConfinementRefusalReason =
  | 'control_evidence_invalid'
  | 'execution_failed'
  | 'input_invalid'
  | 'layout_invalid'
  | 'output_truncated'
  | 'plan_invalid'
  | 'probe_identity_candidate_invalid'
  | 'probe_report_malformed'
  | 'probe_report_mismatch'
  | 'process_failed'
  | 'process_timed_out'
  | 'target_invalid'

type RefusalReason = CodexLabCommandConfinementRefusalReason
export class CodexLabCommandConfinementRefusal extends Error {
  readonly code = CODEX_LAB_COMMAND_CONFINEMENT_REFUSAL_CODE
  constructor(
    readonly reason: RefusalReason,
    readonly field?: string
  ) {
    super(`Codex laboratory command confinement refused: ${reason}`)
    this.name = 'CodexLabCommandConfinementRefusal'
  }
}
