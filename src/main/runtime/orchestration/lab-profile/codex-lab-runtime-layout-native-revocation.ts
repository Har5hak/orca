import { renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  CodexLabRuntimeCleanupIncomplete,
  type CodexLabExistingPathObservation,
  type CodexLabPathIdentity,
  type CodexLabPathObservation
} from './codex-lab-runtime-layout'

export type NativeLayoutRevocationHooks = Readonly<{
  beforeQuarantineRename?: (quarantinePath: string) => void
  afterQuarantineAttested?: (quarantinePath: string) => void
}>

type NativeLayoutRevocationInput = Readonly<{
  path: string
  expectedRoot: CodexLabPathIdentity
  observePath(path: string): CodexLabPathObservation
  assertParentIdentity(path: string): void
  hooks: NativeLayoutRevocationHooks
}>

export function revokeNativeCodexLabActiveLayout(input: NativeLayoutRevocationInput): Readonly<{
  evidence: 'identity-fenced-active-layout-revoked'
  quarantinePath: string
  rootIdentity: CodexLabPathIdentity
}> {
  const quarantine = join(dirname(input.path), `.${basename(input.path)}.cleanup-quarantine`)
  input.assertParentIdentity(input.path)
  const before = input.observePath(input.path)
  const existingQuarantine = input.observePath(quarantine)
  if (before.kind === 'absent') {
    if (existingQuarantine.kind === 'absent') {
      throw new CodexLabRuntimeCleanupIncomplete(quarantine)
    }
    try {
      assertPreliminaryQuarantineIdentity(input, quarantine)
    } catch {
      throw new CodexLabRuntimeCleanupIncomplete(quarantine)
    }
    input.hooks.afterQuarantineAttested?.(quarantine)
    return attestRevokedLayout(input, quarantine)
  }
  assertCapturedRoot(before, input.expectedRoot)
  if (existingQuarantine.kind !== 'absent') {
    throw new Error('The deterministic laboratory cleanup quarantine conflicts with a path.')
  }
  input.hooks.beforeQuarantineRename?.(quarantine)
  input.assertParentIdentity(input.path)
  if (input.observePath(quarantine).kind !== 'absent') {
    throw new Error('The deterministic laboratory cleanup quarantine conflicts with a path.')
  }
  try {
    assertCapturedRoot(requireExisting(input.observePath(input.path)), input.expectedRoot)
  } catch {
    throw new Error('The laboratory Dispatch root changed before quarantine rename.')
  }
  renameSync(input.path, quarantine)
  try {
    assertPreliminaryQuarantineIdentity(input, quarantine)
  } catch {
    throw new CodexLabRuntimeCleanupIncomplete(quarantine)
  }
  input.hooks.afterQuarantineAttested?.(quarantine)
  return attestRevokedLayout(input, quarantine)
}

function assertPreliminaryQuarantineIdentity(
  input: NativeLayoutRevocationInput,
  quarantine: string
): void {
  input.assertParentIdentity(quarantine)
  assertCapturedRoot(requireExisting(input.observePath(quarantine)), input.expectedRoot)
}

function attestRevokedLayout(
  input: NativeLayoutRevocationInput,
  quarantine: string
): Readonly<{
  evidence: 'identity-fenced-active-layout-revoked'
  quarantinePath: string
  rootIdentity: CodexLabPathIdentity
}> {
  try {
    input.assertParentIdentity(quarantine)
    assertCapturedRoot(requireExisting(input.observePath(quarantine)), input.expectedRoot)
    if (input.observePath(input.path).kind !== 'absent') {
      throw new Error('The original laboratory Dispatch path is no longer absent.')
    }
  } catch {
    throw new CodexLabRuntimeCleanupIncomplete(quarantine)
  }
  return Object.freeze({
    evidence: 'identity-fenced-active-layout-revoked',
    quarantinePath: quarantine,
    rootIdentity: Object.freeze({ ...input.expectedRoot })
  })
}

function assertCapturedRoot(
  observed: CodexLabExistingPathObservation,
  expected: CodexLabPathIdentity
): void {
  if (
    observed.kind !== 'directory' ||
    !observed.ownedByCurrentUser ||
    !sameIdentity(observed.identity, expected)
  ) {
    throw new Error('The laboratory Dispatch root no longer has its captured identity.')
  }
}

function requireExisting(observed: CodexLabPathObservation): CodexLabExistingPathObservation {
  if (observed.kind === 'absent') {
    throw new Error('The expected laboratory path is absent.')
  }
  return observed
}

function sameIdentity(left: CodexLabPathIdentity, right: CodexLabPathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}
