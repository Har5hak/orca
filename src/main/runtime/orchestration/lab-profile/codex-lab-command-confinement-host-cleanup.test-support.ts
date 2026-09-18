import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { CODEX_LAB_RUNTIME_ROOT } from './codex-lab-launch-contract'

const COMPATIBILITY_DISPATCH_ID =
  /^compat-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

type PathIdentity = Readonly<{ device: string; inode: string }>
type OwnedPath = Readonly<{
  path: string
  kind: 'directory' | 'file' | 'symlink'
  identity: PathIdentity
}>

export type ExactRootCleanupLease = Readonly<{
  dispatchRoot: string
  record: (path: string, kind: OwnedPath['kind']) => void
  cleanup: () => void
}>

export function createExactRootCleanupLease(dispatchId: string): ExactRootCleanupLease {
  const dispatchesRoot = join(CODEX_LAB_RUNTIME_ROOT, 'dispatches')
  const dispatchRoot = join(dispatchesRoot, dispatchId)
  assertStructuralAuthority(dispatchesRoot, dispatchId, dispatchRoot)
  assertCanonicalDirectory(dispatchesRoot)
  const dispatchesRootIdentity = identityAt(dispatchesRoot)
  mkdirSync(dispatchRoot, { mode: 0o700 })
  const dispatchRootIdentity = identityAt(dispatchRoot)
  try {
    chmodSync(dispatchRoot, 0o700)
    assertCanonicalDirectory(dispatchRoot)
    assertSameIdentity(dispatchesRoot, 'directory', dispatchesRootIdentity)
  } catch (setupError) {
    try {
      assertSameIdentity(dispatchRoot, 'directory', dispatchRootIdentity)
      rmdirSync(dispatchRoot)
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        'fixture root creation and exact-root cleanup both failed'
      )
    }
    throw setupError
  }
  const ownedPaths: OwnedPath[] = [ownedPath(dispatchRoot, 'directory')]
  let cleaned = false

  return {
    dispatchRoot,
    record: (path, kind) => {
      assertWithinRoot(dispatchRoot, path)
      ownedPaths.push(ownedPath(path, kind))
    },
    cleanup: () => {
      if (cleaned) {
        return
      }
      assertStructuralAuthority(dispatchesRoot, dispatchId, dispatchRoot)
      assertCanonicalDirectory(dispatchesRoot)
      assertSameIdentity(dispatchesRoot, 'directory', dispatchesRootIdentity)
      assertCanonicalDirectory(dispatchRoot)
      assertSameIdentity(dispatchRoot, 'directory', dispatchRootIdentity)
      for (const entry of ownedPaths) {
        assertOwnedPath(entry)
      }
      const deletionOrder = snapshotExactRootDeletionOrder(dispatchRoot)
      for (const entry of deletionOrder) {
        assertOwnedPath(entry)
        if (entry.kind === 'directory') {
          rmdirSync(entry.path)
        } else {
          unlinkSync(entry.path)
        }
      }
      cleaned = true
    }
  }
}

function snapshotExactRootDeletionOrder(root: string): OwnedPath[] {
  const entries: OwnedPath[] = []
  const visit = (path: string): void => {
    assertWithinRoot(root, path)
    const current = lstatSync(path)
    if (current.isSymbolicLink()) {
      entries.push({ path, kind: 'symlink', identity: statIdentity(current) })
      return
    }
    if (current.isDirectory()) {
      if (realpathSync(path) !== path) {
        throw new Error('refusing cleanup through a non-canonical path')
      }
      for (const child of readdirSync(path).sort()) {
        visit(join(path, child))
      }
      entries.push({ path, kind: 'directory', identity: statIdentity(current) })
      return
    }
    if (!current.isFile()) {
      throw new Error(`refusing cleanup of a non-file fixture entry: ${path}`)
    }
    entries.push({ path, kind: 'file', identity: statIdentity(current) })
  }
  visit(root)
  return entries
}

function assertStructuralAuthority(
  dispatchesRoot: string,
  dispatchId: string,
  dispatchRoot: string
): void {
  const expectedParent = join(CODEX_LAB_RUNTIME_ROOT, 'dispatches')
  if (
    dispatchesRoot !== expectedParent ||
    !COMPATIBILITY_DISPATCH_ID.test(dispatchId) ||
    basename(dispatchRoot) !== dispatchId ||
    dirname(dispatchRoot) !== expectedParent ||
    dispatchRoot !== join(expectedParent, dispatchId)
  ) {
    throw new Error('refusing cleanup outside the exact test-owned compatibility dispatch root')
  }
}

function assertWithinRoot(root: string, path: string): void {
  const fromRoot = relative(root, path)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error('refusing cleanup outside the exact fixture root')
  }
}

function ownedPath(path: string, kind: OwnedPath['kind']): OwnedPath {
  const current = lstatSync(path)
  if (!hasKind(current, kind)) {
    throw new Error('fixture path has an unexpected kind')
  }
  return { path, kind, identity: statIdentity(current) }
}

function assertOwnedPath(entry: OwnedPath): void {
  assertSameIdentity(entry.path, entry.kind, entry.identity)
}

function assertSameIdentity(path: string, kind: OwnedPath['kind'], expected: PathIdentity): void {
  const current = lstatSync(path)
  if (!hasKind(current, kind)) {
    throw new Error('fixture path kind changed before cleanup')
  }
  const observed = statIdentity(current)
  if (observed.device !== expected.device || observed.inode !== expected.inode) {
    throw new Error('fixture path identity changed before cleanup')
  }
}

function hasKind(
  stat: Readonly<{
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
  }>,
  kind: OwnedPath['kind']
): boolean {
  if (kind === 'directory') {
    return stat.isDirectory() && !stat.isSymbolicLink()
  }
  if (kind === 'file') {
    return stat.isFile() && !stat.isSymbolicLink()
  }
  return stat.isSymbolicLink()
}

function assertCanonicalDirectory(path: string): void {
  const current = lstatSync(path)
  if (!current.isDirectory() || current.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('fixture parent must be an exact canonical directory')
  }
}

function identityAt(path: string): PathIdentity {
  return statIdentity(lstatSync(path))
}

function statIdentity(
  stat: Readonly<{ dev: number | bigint; ino: number | bigint }>
): PathIdentity {
  return { device: String(stat.dev), inode: String(stat.ino) }
}
