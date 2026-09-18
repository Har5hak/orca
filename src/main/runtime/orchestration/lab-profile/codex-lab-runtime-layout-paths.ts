import { basename, dirname, join, normalize } from 'node:path'
import { CODEX_LAB_RUNTIME_ROOT, type SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import type {
  CodexLabPathIdentity,
  CodexLabRuntimeLayoutReason,
  CodexLabRuntimeLayoutRemovalEvidence,
  ExpectedCodexLabLayoutPaths
} from './codex-lab-runtime-layout-contract'

const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export const PRIVATE_ROOT = '/private'
export const PRIVATE_TMP_ROOT = '/private/tmp'
export const LAB_ROOT = '/private/tmp/orca-lab'
export const DISPATCHES_ROOT = join(CODEX_LAB_RUNTIME_ROOT, 'dispatches')

export class CodexLabLayoutRefusal extends Error {
  constructor(readonly reason: CodexLabRuntimeLayoutReason) {
    super(reason)
  }
}

export function expectedCodexLabRuntimeLayoutQuarantinePath(dispatchRoot: string): string {
  return join(dirname(dispatchRoot), `.${basename(dispatchRoot)}.cleanup-quarantine`)
}

export function requireCodexLabRuntimeLayoutRemovalEvidence(input: {
  dispatchRoot: string
  expectedRootIdentity: CodexLabPathIdentity | null
  evidence: CodexLabRuntimeLayoutRemovalEvidence
}): void {
  if (
    input.evidence.evidence !== 'identity-fenced-active-layout-revoked' ||
    input.evidence.quarantinePath !==
      expectedCodexLabRuntimeLayoutQuarantinePath(input.dispatchRoot) ||
    !input.expectedRootIdentity ||
    !input.evidence.rootIdentity ||
    !sameCodexLabPathIdentity(input.evidence.rootIdentity, input.expectedRootIdentity)
  ) {
    throw new Error('Codex laboratory runtime layout revocation evidence is invalid.')
  }
}

export function expectedCodexLabLayoutPaths(
  plan: SealedCodexLabLaunchPlan
): ExpectedCodexLabLayoutPaths {
  const paths = expectedCodexLabLayoutPathsForDispatchId(plan.dispatchId)
  const { dispatchRoot } = paths
  if (
    normalize(plan.runtimePaths.codexHome) !== paths.codexHome ||
    plan.runtimePaths.codexHome !== paths.codexHome ||
    normalize(plan.runtimePaths.fakeHome) !== paths.fakeHome ||
    plan.runtimePaths.fakeHome !== paths.fakeHome ||
    plan.gatewaySocketPath !== join(dispatchRoot, 'gateway.sock')
  ) {
    throw new CodexLabLayoutRefusal('layout_path_invalid')
  }
  return paths
}

export function expectedCodexLabLayoutPathsForDispatchId(
  dispatchId: string
): ExpectedCodexLabLayoutPaths {
  if (!DISPATCH_ID_PATTERN.test(dispatchId) || dispatchId === '.' || dispatchId === '..') {
    throw new CodexLabLayoutRefusal('layout_path_invalid')
  }
  const dispatchRoot = join(DISPATCHES_ROOT, dispatchId)
  return {
    dispatchRoot,
    codexHome: join(dispatchRoot, 'codex-home'),
    fakeHome: join(dispatchRoot, 'fake-home'),
    configPath: join(dispatchRoot, 'codex-home', 'config.toml')
  }
}

export function sameCodexLabPathIdentity(
  left: CodexLabPathIdentity,
  right: CodexLabPathIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode
}

export function codexLabLayoutErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown layout host failure'
}
