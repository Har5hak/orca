import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats
} from 'node:fs'
import { join } from 'node:path'
import type {
  CodexLabTrustedFileObservation,
  CodexLabTrustedLayoutObservation
} from './codex-lab-command-confinement-live-contract'
import type { CodexLabObservedPathIdentity } from './codex-lab-command-confinement-contract'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

export function observeNativeCodexLabExecutable(path: string): CodexLabTrustedFileObservation {
  const named = lstatSync(path, { bigint: true })
  if (!named.isFile() || named.isSymbolicLink() || (named.mode & 0o111n) === 0n) {
    throw new Error('confinement executable must be an executable regular file')
  }
  const observedRealPath = realpathSync(path)
  if (observedRealPath !== path) {
    throw new Error('confinement executable must use its canonical real path')
  }
  const opened = readStableFile(path, identity(named))
  return Object.freeze({
    path,
    observedRealPath,
    kind: 'regular-file' as const,
    executable: true,
    identity: identity(named),
    sha256: opened.sha256
  })
}

export function observeNativeCodexLabLayout(
  prepared: PreparedCodexLabRuntimeLayout
): CodexLabTrustedLayoutObservation {
  const dispatchRootIdentity = observeDirectory(prepared.dispatchRoot, 0o700)
  const codexHomeIdentity = observeDirectory(prepared.codexHome, 0o700)
  const fakeHomeIdentity = observeDirectory(prepared.fakeHome, 0o700)
  const config = lstatSync(prepared.configPath, { bigint: true })
  if (
    !config.isFile() ||
    config.isSymbolicLink() ||
    Number(config.mode & 0o7777n) !== 0o600 ||
    config.uid !== currentUid()
  ) {
    throw new Error('confinement config identity is not an owned mode-0600 regular file')
  }
  const configIdentity = identity(config)
  const configSha256 = readStableFile(prepared.configPath, configIdentity).sha256
  assertAbsentChild(prepared.codexHome, codexHomeIdentity, 'auth.json')
  return Object.freeze({
    dispatchRootIdentity,
    codexHomeIdentity,
    fakeHomeIdentity,
    configIdentity,
    configSha256,
    authJson: 'absent' as const
  })
}

function assertAbsentChild(
  parentPath: string,
  expectedParent: CodexLabObservedPathIdentity,
  childBasename: string
): void {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const directoryOnly = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0
  const descriptor = openSync(parentPath, constants.O_RDONLY | noFollow | directoryOnly)
  try {
    assertDirectoryIdentity(fstatSync(descriptor, { bigint: true }), expectedParent)
    const childPath = join(parentPath, childBasename)
    try {
      lstatSync(childPath, { bigint: true })
      throw new Error(`confinement ${childBasename} must remain absent`)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    }
    assertDirectoryIdentity(fstatSync(descriptor, { bigint: true }), expectedParent)
    assertDirectoryIdentity(lstatSync(parentPath, { bigint: true }), expectedParent)
  } finally {
    closeSync(descriptor)
  }
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === expectedCode
  )
}

export function sha256NativeCodexLabFile(path: string): string {
  const named = lstatSync(path, { bigint: true })
  if (!named.isFile() || named.isSymbolicLink()) {
    throw new Error('confinement read target must be a regular file')
  }
  return readStableFile(path, identity(named)).sha256
}

function observeDirectory(path: string, mode: number): CodexLabObservedPathIdentity {
  const named = lstatSync(path, { bigint: true })
  if (
    !named.isDirectory() ||
    named.isSymbolicLink() ||
    realpathSync(path) !== path ||
    Number(named.mode & 0o7777n) !== mode ||
    named.uid !== currentUid()
  ) {
    throw new Error('confinement directory identity or mode is invalid')
  }
  return identity(named)
}

function assertDirectoryIdentity(
  observed: BigIntStats,
  expected: CodexLabObservedPathIdentity
): void {
  if (
    !observed.isDirectory() ||
    observed.isSymbolicLink() ||
    observed.dev.toString() !== expected.device ||
    observed.ino.toString() !== expected.inode
  ) {
    throw new Error('confinement parent directory identity changed during absence proof')
  }
}

function readStableFile(
  path: string,
  expected: CodexLabObservedPathIdentity
): Readonly<{ sha256: string }> {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const before = fstatSync(descriptor, { bigint: true })
    assertFileIdentity(before, expected)
    const hash = createHash('sha256')
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead = 0
    do {
      bytesRead = readSync(descriptor, chunk, 0, chunk.length, null)
      if (bytesRead > 0) {
        hash.update(chunk.subarray(0, bytesRead))
      }
    } while (bytesRead > 0)
    const after = fstatSync(descriptor, { bigint: true })
    assertFileIdentity(after, expected)
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('confinement file changed during digest readback')
    }
    const named = lstatSync(path, { bigint: true })
    assertFileIdentity(named, expected)
    return { sha256: hash.digest('hex') }
  } finally {
    closeSync(descriptor)
  }
}

function assertFileIdentity(stat: BigIntStats, expected: CodexLabObservedPathIdentity): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.dev.toString() !== expected.device ||
    stat.ino.toString() !== expected.inode
  ) {
    throw new Error('confinement file identity changed during readback')
  }
}

function identity(stat: BigIntStats): CodexLabObservedPathIdentity {
  if (stat.ino === 0n) {
    throw new Error('confinement path did not expose a stable inode')
  }
  return Object.freeze({ device: stat.dev.toString(), inode: stat.ino.toString() })
}

function currentUid(): bigint {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error('live Codex confinement requires a Unix uid')
  }
  return BigInt(uid)
}
