import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat } from 'node:fs/promises'

export type UnixEndpointEvidence = Readonly<{
  device: bigint
  inode: bigint
  uid: bigint
  mode: bigint
  type: 'socket' | 'file' | 'directory' | 'symbolic-link' | 'other'
}>

export type LabUnixSocketEndpointEvidence = Readonly<{
  device: string
  inode: string
  uid: string
  mode: '0600'
  type: 'socket'
}>

export type LabUnixSocketEndpointAttestation = Readonly<{
  evidence: LabUnixSocketEndpointEvidence
  identitySha256: string
}>

export async function requireOwnedMode600Socket(endpoint: string): Promise<UnixEndpointEvidence> {
  const evidence = await readEndpointEvidence(endpoint)
  if (evidence?.type !== 'socket') {
    throw new Error('Laboratory Unix socket endpoint is not a socket')
  }
  if (typeof process.getuid !== 'function' || evidence.uid !== BigInt(process.getuid())) {
    throw new Error('Laboratory Unix socket endpoint is not owned by the current user')
  }
  if (evidence.mode !== 0o600n) {
    throw new Error('Laboratory Unix socket endpoint mode is not 0600')
  }
  return evidence
}

export async function requireOwnedMode700Directory(
  endpoint: string
): Promise<UnixEndpointEvidence> {
  const evidence = await readEndpointEvidence(endpoint)
  if (evidence?.type !== 'directory') {
    throw new Error('Laboratory Unix socket parent is not a directory')
  }
  if (typeof process.getuid !== 'function' || evidence.uid !== BigInt(process.getuid())) {
    throw new Error('Laboratory Unix socket parent is not owned by the current user')
  }
  if (evidence.mode !== 0o700n) {
    throw new Error('Laboratory Unix socket parent mode is not 0700')
  }
  return evidence
}

export async function readEndpointEvidence(endpoint: string): Promise<UnixEndpointEvidence | null> {
  let stats: BigIntStats
  try {
    stats = await lstat(endpoint, { bigint: true })
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
  return Object.freeze({
    device: stats.dev,
    inode: stats.ino,
    uid: stats.uid,
    mode: stats.mode & 0o7777n,
    type: endpointType(stats)
  })
}

export function sameEndpointIdentity(
  left: UnixEndpointEvidence | null,
  right: UnixEndpointEvidence | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.type === right.type
  )
}

export function sameOptionalEndpointIdentity(
  left: UnixEndpointEvidence | null,
  right: UnixEndpointEvidence | null
): boolean {
  return (left === null && right === null) || sameEndpointIdentity(left, right)
}

export function publicEndpointAttestation(
  identity: UnixEndpointEvidence
): LabUnixSocketEndpointAttestation {
  if (identity.type !== 'socket' || identity.mode !== 0o600n) {
    throw new Error('Laboratory Unix socket public endpoint evidence is invalid')
  }
  const evidence: LabUnixSocketEndpointEvidence = Object.freeze({
    device: identity.device.toString(10),
    inode: identity.inode.toString(10),
    uid: identity.uid.toString(10),
    mode: '0600',
    type: 'socket'
  })
  return Object.freeze({
    evidence,
    identitySha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
  })
}

function endpointType(stats: BigIntStats): UnixEndpointEvidence['type'] {
  if (stats.isSocket()) {
    return 'socket'
  }
  if (stats.isFile()) {
    return 'file'
  }
  if (stats.isDirectory()) {
    return 'directory'
  }
  if (stats.isSymbolicLink()) {
    return 'symbolic-link'
  }
  return 'other'
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
