import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative } from 'node:path'
import {
  CodexLabRuntimeCleanupIncomplete,
  type CodexLabExistingPathObservation,
  type CodexLabPathIdentity,
  type CodexLabPathObservation,
  type CodexLabRuntimeLayoutHost
} from './codex-lab-runtime-layout'

type NativeLayoutHostHooks = Readonly<{
  afterQuarantineAttested?: (quarantinePath: string) => void
}>

export function createNativeCodexLabRuntimeLayoutHostAtRoot(
  runtimeRootInput: string,
  randomId: () => string,
  hooks: NativeLayoutHostHooks = {}
): CodexLabRuntimeLayoutHost {
  const runtimeRoot = requireCanonicalAbsolutePath(runtimeRootInput)
  const currentUid = requireCurrentUid()

  const observePath = async (path: string): Promise<CodexLabPathObservation> => {
    assertAllowedPath(path, runtimeRoot)
    return observeNativePath(path, currentUid)
  }

  return Object.freeze({
    observePath,
    makeDirectoryExclusive: async (path, mode, expectedParent) => {
      assertMutableLayoutPath(path, runtimeRoot)
      assertExactMode(mode, 0o700)
      assertParentIdentity(path, expectedParent, currentUid)
      mkdirSync(path, { mode, recursive: false })
      const created = requireExisting(observeNativePath(path, currentUid))
      assertParentIdentity(path, expectedParent, currentUid)
      return created
    },
    writeFileExclusive: async (path, contents, mode, expectedParent) => {
      assertInsideRuntimeRoot(path, runtimeRoot)
      assertExactMode(mode, 0o600)
      assertParentIdentity(path, expectedParent, currentUid)
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
      const descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
        mode
      )
      try {
        writeFileSync(descriptor, contents, { encoding: 'utf8' })
        fsyncSync(descriptor)
        const opened = observationFromStats(fstatSync(descriptor, { bigint: true }), currentUid)
        if (opened.kind !== 'file') {
          throw new Error('The exclusive laboratory config claim is not a regular file.')
        }
        assertParentIdentity(path, expectedParent, currentUid)
        return opened
      } finally {
        closeSync(descriptor)
      }
    },
    sha256File: async (path, expectedFile) => {
      assertInsideRuntimeRoot(path, runtimeRoot)
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
      const descriptor = openSync(path, constants.O_RDONLY | noFollow)
      try {
        const before = fstatSync(descriptor, { bigint: true })
        assertOpenedFile(before, expectedFile, currentUid)
        const contents = readFileSync(descriptor)
        const after = fstatSync(descriptor, { bigint: true })
        assertStableFile(before, after)
        assertOpenedFile(after, expectedFile, currentUid)
        const named = requireExisting(observeNativePath(path, currentUid))
        if (named.kind !== 'file' || !sameIdentity(named.identity, expectedFile)) {
          throw new Error('The laboratory config path changed during digest readback.')
        }
        return createHash('sha256').update(contents).digest('hex')
      } finally {
        closeSync(descriptor)
      }
    },
    removeTree: async (path, expectedRoot, expectedParent) => {
      assertDispatchRootPath(path, runtimeRoot)
      assertParentIdentity(path, expectedParent, currentUid)
      const before = requireExisting(observeNativePath(path, currentUid))
      if (
        before.kind !== 'directory' ||
        !before.ownedByCurrentUser ||
        !sameIdentity(before.identity, expectedRoot)
      ) {
        throw new Error('The laboratory Dispatch root no longer has its captured identity.')
      }
      const quarantineId = randomId()
      if (!/^[A-Za-z0-9-]+$/u.test(quarantineId)) {
        throw new Error('The laboratory cleanup quarantine identity is invalid.')
      }
      const quarantine = join(
        dirname(path),
        `.${basename(path)}.cleanup-${process.pid}-${quarantineId}`
      )
      assertInsideRuntimeRoot(quarantine, runtimeRoot)
      renameSync(path, quarantine)
      const captured = requireExisting(observeNativePath(quarantine, currentUid))
      if (
        captured.kind !== 'directory' ||
        !captured.ownedByCurrentUser ||
        !sameIdentity(captured.identity, expectedRoot)
      ) {
        throw new Error(`A replaced laboratory root was retained at ${quarantine}.`)
      }
      assertParentIdentity(quarantine, expectedParent, currentUid)
      hooks.afterQuarantineAttested?.(quarantine)
      // Node exposes no identity-bound recursive deletion. Retain the quarantined generation and
      // keep cleanup pending instead of resolving this path again and risking replacement loss.
      throw new CodexLabRuntimeCleanupIncomplete(quarantine)
    }
  })
}

function observeNativePath(path: string, currentUid: number): CodexLabPathObservation {
  try {
    return observationFromStats(lstatSync(path, { bigint: true }), currentUid)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { kind: 'absent' }
    }
    throw error
  }
}

function observationFromStats(
  stats: BigIntStats,
  currentUid: number
): CodexLabExistingPathObservation {
  const identity = identityFromStats(stats)
  const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
  return {
    kind,
    mode: Number(stats.mode & 0o7777n),
    ownedByCurrentUser: stats.uid === BigInt(currentUid),
    identity
  }
}

function identityFromStats(stats: BigIntStats): CodexLabPathIdentity {
  if (stats.ino === 0n) {
    throw new Error('The filesystem did not expose a stable inode for the laboratory path.')
  }
  return { device: stats.dev.toString(), inode: stats.ino.toString() }
}

function assertParentIdentity(
  path: string,
  expected: CodexLabPathIdentity,
  currentUid: number
): void {
  const parent = requireExisting(observeNativePath(dirname(path), currentUid))
  if (parent.kind !== 'directory' || !sameIdentity(parent.identity, expected)) {
    throw new Error('The laboratory path parent changed before a filesystem operation.')
  }
}

function assertOpenedFile(
  stats: BigIntStats,
  expected: CodexLabPathIdentity,
  currentUid: number
): void {
  const observed = observationFromStats(stats, currentUid)
  if (
    observed.kind !== 'file' ||
    !observed.ownedByCurrentUser ||
    observed.mode !== 0o600 ||
    !sameIdentity(observed.identity, expected)
  ) {
    throw new Error('The opened laboratory config does not match its captured identity.')
  }
}

function assertStableFile(before: BigIntStats, after: BigIntStats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error('The laboratory config changed during digest readback.')
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

function requireCurrentUid(): number {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error('The native Codex laboratory layout requires a Unix uid.')
  }
  return uid
}

function requireCanonicalAbsolutePath(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error('The Codex laboratory runtime root must be a canonical absolute path.')
  }
  return path
}

function assertAllowedPath(path: string, runtimeRoot: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error('A laboratory filesystem operation received a non-canonical path.')
  }
  const fromRoot = relative(runtimeRoot, path)
  const toRoot = relative(path, runtimeRoot)
  const insideRoot = fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
  const ancestorOfRoot = toRoot === '' || (!toRoot.startsWith('..') && !isAbsolute(toRoot))
  if (!insideRoot && !ancestorOfRoot) {
    throw new Error('A laboratory filesystem operation escaped its configured runtime root.')
  }
}

function assertMutableLayoutPath(path: string, runtimeRoot: string): void {
  assertAllowedPath(path, runtimeRoot)
  const ownedRoot = dirname(runtimeRoot)
  if (path !== ownedRoot && path !== runtimeRoot) {
    assertInsideRuntimeRoot(path, runtimeRoot)
  }
}

function assertInsideRuntimeRoot(path: string, runtimeRoot: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error('A laboratory filesystem operation received a non-canonical path.')
  }
  const fromRoot = relative(runtimeRoot, path)
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error('A laboratory filesystem operation escaped its configured runtime root.')
  }
}

function assertDispatchRootPath(path: string, runtimeRoot: string): void {
  assertInsideRuntimeRoot(path, runtimeRoot)
  const dispatchId = basename(path)
  if (
    dirname(path) !== join(runtimeRoot, 'dispatches') ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(dispatchId) ||
    dispatchId === '.' ||
    dispatchId === '..'
  ) {
    throw new Error('Cleanup requires an exact per-Dispatch laboratory root.')
  }
}

function assertExactMode(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(`A laboratory filesystem operation requested mode ${actual.toString(8)}.`)
  }
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined
  }
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}
