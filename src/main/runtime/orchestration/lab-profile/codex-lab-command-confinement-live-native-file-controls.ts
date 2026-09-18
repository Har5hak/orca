import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from 'node:fs'
import { dirname } from 'node:path'
import type {
  CodexLabFreshWriteControlEvidence,
  CodexLabObservedDirectory,
  CodexLabObservedPathIdentity,
  CodexLabReadControlEvidence
} from './codex-lab-command-confinement-contract'

const PRIVATE_TMP = '/private/tmp' as const

export function observeNativeCodexLabTrustedDirectory(path: string): CodexLabObservedDirectory {
  const observed = lstatSync(path, { bigint: true })
  if (!observed.isDirectory() || observed.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('confinement control parent must be a canonical directory')
  }
  const uid = currentUid()
  const trustedPrivateTmp =
    path === PRIVATE_TMP && observed.uid === 0n && Number(observed.mode & 0o1777n) === 0o1777
  if (observed.uid !== uid && !trustedPrivateTmp) {
    throw new Error('confinement control parent is not under trusted custody')
  }
  return Object.freeze({
    path,
    observedRealPath: path,
    kind: 'directory' as const,
    custody: 'trusted-local-host' as const,
    identity: identity(observed)
  })
}

export function assertNativeCodexLabTrustedDirectoryUnchanged(
  directory: CodexLabObservedDirectory
): void {
  const observed = observeNativeCodexLabTrustedDirectory(directory.path)
  if (!sameNativeCodexLabPathIdentity(observed.identity, directory.identity)) {
    throw new Error('confinement control parent identity changed')
  }
}

export function observeNativeCodexLabReadTarget(target: string): CodexLabReadControlEvidence {
  const observed = readStableRegularFile(target)
  return Object.freeze({
    operation: 'open-read-hash' as const,
    target,
    observedRealPath: target,
    kind: 'regular-file' as const,
    identity: observed.identity,
    sha256: observed.sha256,
    result: 'succeeded' as const
  })
}

export function exerciseNativeCodexLabFreshWrite(
  parent: CodexLabObservedDirectory,
  target: string,
  payload: string
): CodexLabFreshWriteControlEvidence {
  if (dirname(target) !== parent.path || nativeCodexLabPathExists(target)) {
    throw new Error('confinement write sentinel is not fresh in its exact parent')
  }
  assertNativeCodexLabTrustedDirectoryUnchanged(parent)
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)
  let descriptor: number | undefined
  let created: CodexLabObservedPathIdentity | undefined
  let primaryError: unknown
  try {
    descriptor = openSync(target, flags, 0o600)
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile()) {
      throw new Error('confinement write sentinel is not a regular file')
    }
    created = identity(opened)
    writeFileSync(descriptor, payload)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    const readback = readStableRegularFile(target, created)
    if (readback.sha256 !== sha256(payload)) {
      throw new Error('confinement write sentinel readback mismatched')
    }
  } catch (error) {
    primaryError = error
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
  let cleanupError: unknown
  if (created) {
    try {
      unlinkExactRegularFile(target, created, parent)
    } catch (error) {
      cleanupError = error
    }
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'fresh write control and exact cleanup both failed'
    )
  }
  if (primaryError) {
    throw primaryError
  }
  if (cleanupError) {
    throw cleanupError
  }
  if (!created || nativeCodexLabPathExists(target)) {
    throw new Error('confinement write sentinel cleanup is incomplete')
  }
  return Object.freeze({
    operation: 'exclusive-create-write-read-unlink' as const,
    parent,
    target,
    targetBefore: 'absent' as const,
    exclusiveCreate: 'succeeded' as const,
    readBack: 'succeeded' as const,
    payloadSha256: sha256(payload),
    unlink: 'succeeded' as const,
    targetAfter: 'absent' as const
  })
}

export function assertNativeCodexLabPathAbsent(path: string): void {
  if (nativeCodexLabPathExists(path)) {
    throw new Error(`confinement proof target was replaced or left behind: ${path}`)
  }
}

export function sameNativeCodexLabPathIdentity(
  left: CodexLabObservedPathIdentity,
  right: CodexLabObservedPathIdentity
): boolean {
  return left.device === right.device && left.inode === right.inode
}

function nativeCodexLabPathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }
    throw error
  }
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === expectedCode
  )
}

function unlinkExactRegularFile(
  target: string,
  expected: CodexLabObservedPathIdentity,
  parent: CodexLabObservedDirectory
): void {
  assertNativeCodexLabTrustedDirectoryUnchanged(parent)
  const observed = lstatSync(target, { bigint: true })
  if (
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    !sameNativeCodexLabPathIdentity(identity(observed), expected)
  ) {
    throw new Error('refusing to unlink a replaced confinement write sentinel')
  }
  unlinkSync(target)
  assertNativeCodexLabTrustedDirectoryUnchanged(parent)
}

function readStableRegularFile(
  target: string,
  expected?: CodexLabObservedPathIdentity
): Readonly<{ identity: CodexLabObservedPathIdentity; sha256: string }> {
  const named = lstatSync(target, { bigint: true })
  if (!named.isFile() || named.isSymbolicLink() || realpathSync(target) !== target) {
    throw new Error('confinement read target must be a canonical regular file')
  }
  const expectedIdentity = expected ?? identity(named)
  if (!sameNativeCodexLabPathIdentity(identity(named), expectedIdentity)) {
    throw new Error('confinement read target identity changed before open')
  }
  const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(descriptor, { bigint: true })
    assertStableFile(before, expectedIdentity)
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    assertStableFile(after, expectedIdentity)
    const namedAfter = lstatSync(target, { bigint: true })
    assertStableFile(namedAfter, expectedIdentity)
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('confinement read target changed during read')
    }
    return Object.freeze({ identity: expectedIdentity, sha256: sha256(contents) })
  } finally {
    closeSync(descriptor)
  }
}

function assertStableFile(observed: BigIntStats, expected: CodexLabObservedPathIdentity): void {
  if (!observed.isFile() || !sameNativeCodexLabPathIdentity(identity(observed), expected)) {
    throw new Error('confinement file identity changed during read')
  }
}

function identity(observed: BigIntStats): CodexLabObservedPathIdentity {
  if (observed.ino === 0n) {
    throw new Error('confinement control path did not expose a stable inode')
  }
  return Object.freeze({ device: observed.dev.toString(), inode: observed.ino.toString() })
}

function currentUid(): bigint {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error('live Codex confinement requires a Unix uid')
  }
  return BigInt(uid)
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
