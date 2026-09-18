import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { visit } from 'jsonc-parser'
import {
  CodexLabCommandConfinementRefusal,
  type CodexLabCommandConfinementControlEvidence,
  type CodexLabCommandConfinementRefusalReason,
  type CodexLabFreshWriteControlEvidence,
  type CodexLabObservedDirectory,
  type CodexLabObservedPathIdentity,
  type CodexLabProbeIdentityCandidate
} from './codex-lab-command-confinement-contract'
import {
  CODEX_LAB_CONFINEMENT_CONTROLS_SHAPE,
  CODEX_LAB_CONFINEMENT_INPUT_SHAPE,
  CODEX_LAB_CONFINEMENT_LAYOUT_SHAPE,
  CODEX_LAB_CONFINEMENT_PLAN_SHAPE,
  CODEX_LAB_CONFINEMENT_PROBE_SHAPE,
  snapshotExactCodexLabValue,
  type CodexLabExactShape
} from './codex-lab-command-confinement-shape'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

const SHA256 = /^[a-f0-9]{64}$/
const NONCE = /^[a-f0-9]{32}$/
const POSITIVE = /^[1-9][0-9]*$/
const PRIVATE_TMP = '/private/tmp' as const
const snapshot = <T>(
  candidate: unknown,
  shape: CodexLabExactShape,
  reason: CodexLabCommandConfinementRefusalReason,
  field: string
): T => snapshotExactCodexLabValue<T>({ candidate, shape, reason, field })

type Targets = Readonly<
  Record<
    | 'worktreeWrite'
    | 'codexHomeWrite'
    | 'fakeHomeWrite'
    | 'privateTmpWrite'
    | 'outsideRootWrite'
    | 'unixConnectDenied'
    | 'unixBind',
    string
  >
>
type Envelope = Readonly<{
  plan: SealedCodexLabLaunchPlan
  preparedLayout: unknown
  probeIdentityCandidate: unknown
  runNonce: string
  controls: unknown
}>

export function readCodexLabCommandConfinementInputEnvelope(candidate: unknown): Envelope {
  const envelope = snapshot<Envelope>(
    candidate,
    CODEX_LAB_CONFINEMENT_INPUT_SHAPE,
    'input_invalid',
    'input'
  )
  const plan = snapshot<SealedCodexLabLaunchPlan>(
    envelope.plan,
    CODEX_LAB_CONFINEMENT_PLAN_SHAPE,
    'plan_invalid',
    'plan'
  )
  return Object.freeze({ ...envelope, plan })
}

export function snapshotAndValidateCodexLabPreparedLayout(
  plan: SealedCodexLabLaunchPlan,
  candidate: unknown
): PreparedCodexLabRuntimeLayout {
  const value = snapshot<PreparedCodexLabRuntimeLayout>(
    candidate,
    CODEX_LAB_CONFINEMENT_LAYOUT_SHAPE,
    'layout_invalid',
    'preparedLayout'
  )
  const identities = [
    value.dispatchesRootIdentity,
    value.dispatchRootIdentity,
    value.codexHomeIdentity,
    value.fakeHomeIdentity,
    value.configIdentity
  ]
  if (
    value.schemaVersion !== 1 ||
    value.dispatchId !== plan.dispatchId ||
    value.codexHome !== plan.runtimePaths.codexHome ||
    value.fakeHome !== plan.runtimePaths.fakeHome ||
    value.dispatchRoot !== dirname(value.codexHome) ||
    value.dispatchRoot !== dirname(value.fakeHome) ||
    value.dispatchRoot !== dirname(plan.gatewaySocketPath) ||
    value.configPath !== join(value.codexHome, 'config.toml') ||
    value.configSha256 !== plan.receiptInputs.configSha256 ||
    !canonicalPath(value.dispatchRoot) ||
    !identities.every(identityValid)
  ) {
    throw new CodexLabCommandConfinementRefusal('layout_invalid')
  }
  return value
}

export function snapshotAndValidateCodexLabProbeCandidate(
  candidate: unknown
): CodexLabProbeIdentityCandidate {
  const value = snapshot<CodexLabProbeIdentityCandidate>(
    candidate,
    CODEX_LAB_CONFINEMENT_PROBE_SHAPE,
    'probe_identity_candidate_invalid',
    'probeIdentityCandidate'
  )
  if (
    !canonicalPath(value.path) ||
    value.observedRealPath !== value.path ||
    !SHA256.test(value.expectedSha256Candidate) ||
    value.observedSha256 !== value.expectedSha256Candidate ||
    !identityValid(value)
  ) {
    throw new CodexLabCommandConfinementRefusal('probe_identity_candidate_invalid')
  }
  return value
}

export function snapshotCodexLabCommandConfinementControls(
  controls: unknown
): CodexLabCommandConfinementControlEvidence {
  return snapshot(
    controls,
    CODEX_LAB_CONFINEMENT_CONTROLS_SHAPE,
    'control_evidence_invalid',
    'controls'
  )
}

export function validateCodexLabCommandConfinementControls(args: {
  plan: SealedCodexLabLaunchPlan
  prepared: PreparedCodexLabRuntimeLayout
  runNonce: string
  controls: CodexLabCommandConfinementControlEvidence
  targets: Targets
}): void {
  const { plan, prepared, runNonce, controls, targets } = args
  const writes = controls.writes
  const writeChecks: readonly Parameters<typeof validWrite>[] = [
    [writes.worktree, targets.worktreeWrite, plan.cwd],
    [writes.codexHome, targets.codexHomeWrite, prepared.codexHome, prepared.codexHomeIdentity],
    [writes.fakeHome, targets.fakeHomeWrite, prepared.fakeHome, prepared.fakeHomeIdentity],
    [writes.privateTmp, targets.privateTmpWrite, PRIVATE_TMP],
    [writes.outsideRoot, targets.outsideRootWrite, writes.outsideRoot.parent.path]
  ]
  const { tcpConnect, unixConnect, unixConnectDenied, unixBind } = controls.network
  requireControl(validRead(controls, plan.cwd), 'worktreeRead')
  requireControl(
    writeChecks.every((write) => validWrite(...write)) &&
      !inside(PRIVATE_TMP, writes.outsideRoot.parent.path) &&
      Object.values(writes).every((write) => write.payloadSha256 === sha256(runNonce)),
    'writes'
  )
  requireControl(
    Number.isInteger(tcpConnect.port) &&
      tcpConnect.port >= 1 &&
      tcpConnect.port <= 65_535 &&
      live(tcpConnect),
    'network.tcpConnect'
  )
  requireControl(
    unixConnect.path === plan.gatewaySocketPath && live(unixConnect),
    'network.unixConnect'
  )
  requireControl(
    unixConnectDenied.path === targets.unixConnectDenied && live(unixConnectDenied),
    'network.unixConnectDenied'
  )
  requireControl(
    unixBind.path === targets.unixBind &&
      unixBind.parent.path === PRIVATE_TMP &&
      validDirectory(unixBind.parent),
    'network.unixBind'
  )
  requireControl(
    sameIdentity(unixBind.parent.identity, writes.privateTmp.parent.identity),
    'network.unixBind.parent.identity'
  )
}

function validRead(controls: CodexLabCommandConfinementControlEvidence, root: string): boolean {
  const read = controls.worktreeRead
  return (
    canonicalPath(read.target) &&
    inside(root, read.target) &&
    read.target !== root &&
    read.observedRealPath === read.target &&
    identityValid(read.identity) &&
    SHA256.test(read.sha256)
  )
}

function validWrite(
  write: CodexLabFreshWriteControlEvidence,
  target: string,
  parent: string,
  identity?: CodexLabObservedPathIdentity
): boolean {
  return (
    write.target === target &&
    write.parent.path === parent &&
    dirname(write.target) === write.parent.path &&
    SHA256.test(write.payloadSha256) &&
    validDirectory(write.parent, identity)
  )
}

function validDirectory(
  directory: CodexLabObservedDirectory,
  identity?: CodexLabObservedPathIdentity
): boolean {
  return (
    canonicalPath(directory.path) &&
    directory.observedRealPath === directory.path &&
    identityValid(directory.identity) &&
    (!identity || sameIdentity(directory.identity, identity))
  )
}

function requireControl(valid: boolean, field: string): void {
  if (!valid) {
    throw new CodexLabCommandConfinementRefusal('control_evidence_invalid', field)
  }
}

function live(value: { challengeToken: string; challengeSha256: string }): boolean {
  return NONCE.test(value.challengeToken) && value.challengeSha256 === sha256(value.challengeToken)
}
function identityValid(value: CodexLabObservedPathIdentity): boolean {
  return POSITIVE.test(value.device) && POSITIVE.test(value.inode)
}
function sameIdentity(
  left: CodexLabObservedPathIdentity,
  right: CodexLabObservedPathIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode
}
function canonicalPath(value: string): boolean {
  return (
    value.length > 1 &&
    value === value.trim() &&
    !value.includes('\u0000') &&
    isAbsolute(value) &&
    normalize(value) === value
  )
}
function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export function invalidCodexLabProbeReportJson(source: string): boolean {
  if (!source) {
    return true
  }
  const stack: Set<string>[] = []
  let invalid = false
  visit(
    source,
    {
      onObjectBegin: () => {
        stack.push(new Set())
      },
      onObjectProperty: (property) => {
        const current = stack.at(-1)
        if (!current || current.has(property)) {
          invalid = true
        } else {
          current.add(property)
        }
      },
      onObjectEnd: () => void stack.pop(),
      onError: () => {
        invalid = true
      }
    },
    { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false }
  )
  return invalid
}
