import { existsSync, lstatSync, unlinkSync, type BigIntStats } from 'node:fs'
import {
  createConnection,
  createServer,
  type ListenOptions,
  type Server,
  type Socket
} from 'node:net'
import type {
  CodexLabCommandConfinementControlEvidence,
  CodexLabObservedDirectory,
  CodexLabObservedPathIdentity
} from './codex-lab-command-confinement-contract'
import {
  assertNativeCodexLabTrustedDirectoryUnchanged,
  sameNativeCodexLabPathIdentity
} from './codex-lab-command-confinement-live-native-file-controls'

const LOOPBACK = '127.0.0.1' as const
const CHALLENGE_TIMEOUT_MS = 2_000

type ListenerState = {
  accepted: number
  exchanged: number
  error?: Error
}

export type NativeCodexLabChallengeServer = Readonly<{
  server: Server
  state: ListenerState
}>

export function createNativeCodexLabChallengeServer(
  challenge: string
): NativeCodexLabChallengeServer {
  const state: ListenerState = { accepted: 0, exchanged: 0 }
  const server = createServer((socket) => handleChallenge(socket, challenge, state))
  server.on('error', (error) => {
    state.error ??= error
  })
  return { server, state }
}

export function exchangeNativeCodexLabChallenge(
  options: Readonly<{ host: string; port: number }> | Readonly<{ path: string }>,
  challenge: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket =
      'path' in options ? createConnection({ path: options.path }) : createConnection(options)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('trusted listener challenge timed out'))
    }, CHALLENGE_TIMEOUT_MS)
    socket.once('connect', () => socket.end(challenge))
    socket.on('data', (chunk: Buffer) => chunks.push(chunk))
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('end', () => {
      clearTimeout(timer)
      if (Buffer.concat(chunks).toString('utf8') !== challenge) {
        reject(new Error('trusted listener challenge response mismatched'))
      } else {
        resolve()
      }
    })
  })
}

export async function exerciseNativeCodexLabTcpBind(): Promise<
  CodexLabCommandConfinementControlEvidence['network']['tcpBind']
> {
  const server = createServer()
  await listenNativeCodexLabServer(server, { host: LOOPBACK, port: 0, exclusive: true })
  await closeNativeCodexLabServer(server)
  return Object.freeze({
    host: LOOPBACK,
    port: 0 as const,
    bind: 'succeeded' as const,
    listen: 'succeeded' as const,
    close: 'succeeded' as const
  })
}

export async function exerciseNativeCodexLabUnixBind(
  path: string,
  parent: CodexLabObservedDirectory
): Promise<CodexLabCommandConfinementControlEvidence['network']['unixBind']> {
  assertNativeCodexLabTrustedDirectoryUnchanged(parent)
  const server = createServer()
  let created: CodexLabObservedPathIdentity | undefined
  try {
    await listenNativeCodexLabServer(server, { path, exclusive: true })
    created = nativeCodexLabSocketIdentity(path)
    await closeNativeCodexLabServer(server)
    unlinkExactNativeCodexLabSocket(path, created, parent)
  } catch (error) {
    const failures: unknown[] = [error]
    try {
      await closeNativeCodexLabServer(server)
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
    if (created && existsSync(path)) {
      try {
        unlinkExactNativeCodexLabSocket(path, created, parent)
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, 'Unix bind control and exact cleanup both failed')
  }
  return Object.freeze({
    operation: 'bind-listen-close-unlink' as const,
    parent,
    path,
    targetBefore: 'absent' as const,
    bind: 'succeeded' as const,
    listen: 'succeeded' as const,
    close: 'succeeded' as const,
    unlink: 'succeeded' as const,
    targetAfter: 'absent' as const
  })
}

export function listenNativeCodexLabServer(server: Server, options: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(options, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

export function closeNativeCodexLabServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

export function unlinkExactNativeCodexLabSocket(
  path: string,
  expected: CodexLabObservedPathIdentity,
  parent: CodexLabObservedDirectory
): void {
  assertNativeCodexLabTrustedDirectoryUnchanged(parent)
  // Node removes a bound Unix socket during Server.close() on macOS. If the
  // name remains, remove only the exact socket inode captured after listen.
  if (existsSync(path)) {
    assertNativeCodexLabSocketIdentity(path, expected)
    unlinkSync(path)
  }
  if (existsSync(path)) {
    throw new Error('Unix socket cleanup did not remove the exact target')
  }
  assertNativeCodexLabTrustedDirectoryUnchanged(parent)
}

export function assertNativeCodexLabSocketIdentity(
  path: string,
  expected: CodexLabObservedPathIdentity
): void {
  if (!sameNativeCodexLabPathIdentity(nativeCodexLabSocketIdentity(path), expected)) {
    throw new Error('refusing to trust or unlink a replaced Unix socket')
  }
}

export function nativeCodexLabSocketIdentity(path: string): CodexLabObservedPathIdentity {
  const observed = lstatSync(path, { bigint: true })
  if (!observed.isSocket() || observed.isSymbolicLink()) {
    throw new Error('confinement Unix target is not a socket')
  }
  return identity(observed)
}

function handleChallenge(socket: Socket, challenge: string, state: ListenerState): void {
  state.accepted += 1
  const chunks: Buffer[] = []
  let bytes = 0
  socket.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > Buffer.byteLength(challenge)) {
      socket.destroy()
      return
    }
    chunks.push(chunk)
  })
  socket.on('error', () => {})
  socket.on('end', () => {
    if (Buffer.concat(chunks).toString('utf8') !== challenge) {
      socket.destroy()
      return
    }
    state.exchanged += 1
    socket.end(challenge)
  })
}

function identity(observed: BigIntStats): CodexLabObservedPathIdentity {
  if (observed.ino === 0n) {
    throw new Error('Unix socket did not expose a stable inode')
  }
  return Object.freeze({ device: observed.dev.toString(), inode: observed.ino.toString() })
}
