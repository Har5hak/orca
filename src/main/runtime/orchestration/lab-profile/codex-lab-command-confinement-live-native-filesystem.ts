import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type {
  CodexLabFreshWriteControlEvidence,
  CodexLabObservedDirectory,
  CodexLabReadControlEvidence
} from './codex-lab-command-confinement-contract'
import {
  assertNativeCodexLabPathAbsent,
  exerciseNativeCodexLabFreshWrite,
  observeNativeCodexLabReadTarget,
  observeNativeCodexLabTrustedDirectory,
  sameNativeCodexLabPathIdentity
} from './codex-lab-command-confinement-live-native-file-controls'
import type { CodexLabCommandConfinementTargets } from './codex-lab-command-confinement-preflight'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

const PRIVATE_TMP = '/private/tmp' as const

export type NativeCodexLabFilesystemControls = Readonly<{
  worktreeRead: CodexLabReadControlEvidence
  writes: Readonly<{
    worktree: CodexLabFreshWriteControlEvidence
    codexHome: CodexLabFreshWriteControlEvidence
    fakeHome: CodexLabFreshWriteControlEvidence
    privateTmp: CodexLabFreshWriteControlEvidence
    outsideRoot: CodexLabFreshWriteControlEvidence
  }>
  privateTmp: CodexLabObservedDirectory
}>

export function collectNativeCodexLabFilesystemControls(args: {
  plan: SealedCodexLabLaunchPlan
  preparedLayout: PreparedCodexLabRuntimeLayout
  worktreeReadTarget: string
  outsideWriteRoot: string
  runNonce: string
  targets: CodexLabCommandConfinementTargets
}): NativeCodexLabFilesystemControls {
  const { plan, preparedLayout: prepared, targets } = args
  assertExactProofPaths(args)
  const parents = {
    worktree: observeNativeCodexLabTrustedDirectory(plan.cwd),
    codexHome: observeNativeCodexLabTrustedDirectory(prepared.codexHome),
    fakeHome: observeNativeCodexLabTrustedDirectory(prepared.fakeHome),
    privateTmp: observeNativeCodexLabTrustedDirectory(PRIVATE_TMP),
    outsideRoot: observeNativeCodexLabTrustedDirectory(args.outsideWriteRoot)
  }
  const payloadSha256 = sha256(args.runNonce)
  const writes = {
    worktree: exerciseNativeCodexLabFreshWrite(
      parents.worktree,
      targets.worktreeWrite,
      args.runNonce
    ),
    codexHome: exerciseNativeCodexLabFreshWrite(
      parents.codexHome,
      targets.codexHomeWrite,
      args.runNonce
    ),
    fakeHome: exerciseNativeCodexLabFreshWrite(
      parents.fakeHome,
      targets.fakeHomeWrite,
      args.runNonce
    ),
    privateTmp: exerciseNativeCodexLabFreshWrite(
      parents.privateTmp,
      targets.privateTmpWrite,
      args.runNonce
    ),
    outsideRoot: exerciseNativeCodexLabFreshWrite(
      parents.outsideRoot,
      targets.outsideRootWrite,
      args.runNonce
    )
  }
  if (!Object.values(writes).every((write) => write.payloadSha256 === payloadSha256)) {
    throw new Error('fresh write controls did not bind the run nonce')
  }
  return deepFreeze({
    worktreeRead: observeNativeCodexLabReadTarget(args.worktreeReadTarget),
    writes,
    privateTmp: parents.privateTmp
  })
}

export function assertNativeCodexLabFilesystemControlsUnchanged(args: {
  plan: SealedCodexLabLaunchPlan
  preparedLayout: PreparedCodexLabRuntimeLayout
  worktreeReadTarget: string
  outsideWriteRoot: string
  targets: CodexLabCommandConfinementTargets
  controls: NativeCodexLabFilesystemControls
}): void {
  assertExactProofPaths(args)
  const { plan, preparedLayout: prepared, controls } = args
  assertNativeCodexLabWriteParentUnchanged('worktree', plan.cwd, controls)
  assertNativeCodexLabWriteParentUnchanged('codexHome', prepared.codexHome, controls)
  assertNativeCodexLabWriteParentUnchanged('fakeHome', prepared.fakeHome, controls)
  assertNativeCodexLabWriteParentUnchanged('privateTmp', PRIVATE_TMP, controls)
  assertNativeCodexLabWriteParentUnchanged('outsideRoot', args.outsideWriteRoot, controls)
  const read = observeNativeCodexLabReadTarget(args.worktreeReadTarget)
  if (
    !sameNativeCodexLabPathIdentity(read.identity, controls.worktreeRead.identity) ||
    read.sha256 !== controls.worktreeRead.sha256
  ) {
    throw new Error('worktree .git identity or digest changed during confinement proof')
  }
  for (const target of [
    args.targets.worktreeWrite,
    args.targets.codexHomeWrite,
    args.targets.fakeHomeWrite,
    args.targets.privateTmpWrite,
    args.targets.outsideRootWrite,
    args.targets.unixBind
  ]) {
    assertNativeCodexLabPathAbsent(target)
  }
}

function assertNativeCodexLabWriteParentUnchanged(
  name: keyof NativeCodexLabFilesystemControls['writes'],
  path: string,
  controls: NativeCodexLabFilesystemControls
): void {
  const observed = observeNativeCodexLabTrustedDirectory(path)
  if (!sameNativeCodexLabPathIdentity(observed.identity, controls.writes[name].parent.identity)) {
    throw new Error(`confinement ${name} parent identity changed during proof`)
  }
}

function assertExactProofPaths(args: {
  plan: SealedCodexLabLaunchPlan
  worktreeReadTarget: string
  outsideWriteRoot: string
}): void {
  const expectedReadTarget = join(args.plan.cwd, '.git')
  if (
    args.worktreeReadTarget !== expectedReadTarget ||
    dirname(args.worktreeReadTarget) !== args.plan.cwd ||
    basename(args.worktreeReadTarget) !== '.git'
  ) {
    throw new Error('confinement read proof must use the linked-worktree .git file')
  }
  const expectedOutsideRoot = realpathSync(userInfo().homedir)
  if (args.outsideWriteRoot !== expectedOutsideRoot) {
    throw new Error('confinement outside-root proof must use the current OS user home')
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      deepFreeze(nested)
    }
  }
  return Object.freeze(value)
}
