// Why: this is the original Unix socket / named pipe transport extracted from
// runtime-rpc.ts. It preserves the exact same behavior: newline-delimited JSON,
// 30s idle timeout, 1MB max message, 32 max connections, chmod 0o600 on Unix.
// It also owns the keepalive timer and per-connection abort signal so the
// server-side handler can cancel long-poll dispatches when the client goes
// away. See design doc §3.1.
import { chmodSync, existsSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  LabUnixSocketLifecycle,
  type LabUnixSocketEndpointAttestation,
  type LabUnixSocketLifecycleHooks
} from './lab-unix-socket-lifecycle'
import type { RpcTransport } from './transport'
import {
  UNIX_SOCKET_TRANSPORT_LIMITS,
  type UnixSocketMessageHandler,
  type UnixSocketTransportOptions
} from './unix-socket-transport-contract'
export type { UnixSocketTransportOptions } from './unix-socket-transport-contract'

export class UnixSocketTransport implements RpcTransport {
  private readonly endpoint: string
  private readonly kind: 'unix' | 'named-pipe'
  private readonly labUnixSocketLifecycle: LabUnixSocketLifecycle | null
  private readonly keepaliveIntervalMs: number
  private server: Server | null = null
  private listeningReady = false
  private startOperation: Promise<void> | null = null
  private stopOperation: Promise<void> | null = null
  private messageHandler: UnixSocketMessageHandler | null = null
  private readonly activeSockets = new Set<Socket>()

  constructor(
    {
      endpoint,
      kind,
      keepaliveIntervalMs,
      unixSocketLifecycle = 'legacy'
    }: UnixSocketTransportOptions,
    labHooks: LabUnixSocketLifecycleHooks = {}
  ) {
    if (kind !== 'unix' && unixSocketLifecycle !== 'legacy') {
      throw new Error('Attested Unix socket lifecycle requires a Unix endpoint')
    }
    this.endpoint = endpoint
    this.kind = kind
    this.labUnixSocketLifecycle =
      unixSocketLifecycle === 'lab-refuse-existing-retain'
        ? new LabUnixSocketLifecycle(endpoint, labHooks)
        : null
    this.keepaliveIntervalMs =
      keepaliveIntervalMs ?? UNIX_SOCKET_TRANSPORT_LIMITS.keepaliveIntervalMs
  }

  static forLaboratoryGateway(
    endpoint: string,
    hooks: LabUnixSocketLifecycleHooks = {}
  ): UnixSocketTransport {
    return new UnixSocketTransport(
      { endpoint, kind: 'unix', unixSocketLifecycle: 'lab-refuse-existing-retain' },
      hooks
    )
  }

  onMessage(handler: UnixSocketMessageHandler): void {
    this.messageHandler = handler
  }

  async attestLaboratoryEndpoint(): Promise<LabUnixSocketEndpointAttestation> {
    if (!this.labUnixSocketLifecycle || !this.listeningReady) {
      throw new Error('Laboratory Unix socket transport is not ready for attestation')
    }
    return await this.labUnixSocketLifecycle.attestPublishedEndpoint()
  }

  start(): Promise<void> {
    if (this.stopOperation) {
      return this.stopOperation.then(() => this.start())
    }
    if (this.startOperation) {
      return this.startOperation
    }
    if (this.listeningReady) {
      return Promise.resolve()
    }
    if (this.server) {
      return Promise.reject(new Error('Unix socket transport cleanup is still pending'))
    }

    const operation = this.startOnce()
    this.startOperation = operation
    operation.then(
      () => this.clearStartOperation(operation),
      () => this.clearStartOperation(operation)
    )
    return operation
  }

  stop(): Promise<void> {
    if (this.stopOperation) {
      return this.stopOperation
    }

    const operation = this.stopOnce()
    this.stopOperation = operation
    operation.then(
      () => this.clearStopOperation(operation),
      () => this.clearStopOperation(operation)
    )
    return operation
  }

  private async startOnce(): Promise<void> {
    if (this.labUnixSocketLifecycle) {
      const server = this.createServer()
      try {
        await this.labUnixSocketLifecycle.start(server, async () => await this.closeServer(server))
      } catch (error) {
        if (
          this.labUnixSocketLifecycle.hasCleanupCustody &&
          !this.labUnixSocketLifecycle.isDefinitivelyClosed
        ) {
          this.server = server
        }
        throw error
      }
      this.server = server
      this.listeningReady = true
      return
    }

    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }

    const server = this.createServer()
    await listen(server, this.endpoint)

    if (this.kind === 'unix') {
      chmodSync(this.endpoint, 0o600)
    }

    this.server = server
    this.listeningReady = true
  }

  private async stopOnce(): Promise<void> {
    const starting = this.startOperation
    if (starting) {
      await starting.catch(() => undefined)
    }
    const server = this.server
    if (!server) {
      if (this.labUnixSocketLifecycle?.isDefinitivelyClosed) {
        await this.labUnixSocketLifecycle.stop(async () => undefined)
      }
      return
    }

    if (this.labUnixSocketLifecycle) {
      try {
        await this.labUnixSocketLifecycle.stop(async () => await this.closeServer(server))
      } finally {
        if (this.labUnixSocketLifecycle.isDefinitivelyClosed) {
          this.server = null
          this.listeningReady = false
        }
      }
      return
    }

    await this.closeServer(server)
    this.server = null
    this.listeningReady = false
    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }
  }

  private createServer(): Server {
    const server = createServer((socket) => {
      this.handleConnection(socket)
    })
    server.maxConnections = UNIX_SOCKET_TRANSPORT_LIMITS.maxConnections
    return server
  }

  private async closeServer(server: Server): Promise<void> {
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    // Why: server.close() stops accepting new connections but waits for
    // existing sockets; long-poll keepalives can otherwise hold shutdown open.
    for (const socket of Array.from(this.activeSockets)) {
      socket.destroy()
    }
    await closePromise
  }

  private clearStartOperation(operation: Promise<void>): void {
    if (this.startOperation === operation) {
      this.startOperation = null
    }
  }

  private clearStopOperation(operation: Promise<void>): void {
    if (this.stopOperation === operation) {
      this.stopOperation = null
    }
  }

  private handleConnection(socket: Socket): void {
    this.activeSockets.add(socket)
    let buffer = ''
    let retainedBytes = 0
    let oversized = false
    // Why: each in-flight dispatch registers its own AbortController here so
    // `socket.on('close')` can abort them all at once. Keeping the set scoped
    // to the connection (rather than a single shared controller) means
    // completing one dispatch does not abort any other dispatch still running
    // on the same socket — future-proofing for a persistent CLI socket that
    // multiplexes sequential requests.
    const inflight = new Set<() => void>()

    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(UNIX_SOCKET_TRANSPORT_LIMITS.idleTimeoutMs, () => {
      socket.destroy()
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.once('close', () => {
      for (const cleanup of inflight) {
        cleanup()
      }
      inflight.clear()
      this.activeSockets.delete(socket)
    })
    socket.on('data', (chunk: string) => {
      if (oversized) {
        return
      }
      buffer += chunk
      // setEncoding('utf8') keeps split codepoints intact, so chunk byte lengths add exactly.
      retainedBytes += Buffer.byteLength(chunk, 'utf8')
      // Why: the Orca runtime lives in Electron main, so it must reject
      // oversized local RPC frames instead of letting a local client grow an
      // unbounded buffer and stall the app.
      if (retainedBytes > UNIX_SOCKET_TRANSPORT_LIMITS.maxMessageBytes) {
        oversized = true
        this.messageHandler?.('', (response) => {
          socket.write(`${response}\n`)
          socket.end()
        })
        return
      }
      if (!chunk.includes('\n')) {
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawMessage) {
          this.dispatchMessage(socket, rawMessage, inflight)
        }
        newlineIndex = buffer.indexOf('\n')
      }
      retainedBytes = Buffer.byteLength(buffer, 'utf8')
    })
  }

  // Why: the keepalive timer is opt-in per request via `startKeepalive()`.
  // Short RPCs never call it and pay no timer overhead; only long-poll
  // handlers (e.g. orchestration.check --wait) arm it. See §3.1.
  private dispatchMessage(socket: Socket, rawMessage: string, inflight: Set<() => void>): void {
    let replied = false
    let keepaliveTimer: NodeJS.Timeout | null = null
    // Why: each dispatch needs its own abort signal and keepalive timer
    // cleanup. Socket close runs every cleanup without touching sibling
    // dispatches that already replied on the same connection.
    const abortController = new AbortController()
    let cleanedUp = false
    const cleanupDispatch = (abort: boolean): void => {
      if (cleanedUp) {
        return
      }
      cleanedUp = true
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      if (abort) {
        abortController.abort()
      }
      inflight.delete(abortDispatch)
    }
    const abortDispatch = (): void => cleanupDispatch(true)
    inflight.add(abortDispatch)

    const reply = (response: string): void => {
      if (replied) {
        return
      }
      replied = true
      cleanupDispatch(false)
      if (!socket.destroyed && socket.writable) {
        socket.write(`${response}\n`)
      }
    }

    const startKeepalive = (): void => {
      if (keepaliveTimer || replied) {
        return
      }
      keepaliveTimer = setInterval(() => {
        if (replied || socket.destroyed || !socket.writable) {
          cleanupDispatch(socket.destroyed || !socket.writable)
          return
        }
        socket.write('{"_keepalive":true}\n')
      }, this.keepaliveIntervalMs)
      // Why: don't hold the process open solely on the keepalive interval.
      if (typeof keepaliveTimer.unref === 'function') {
        keepaliveTimer.unref()
      }
    }

    this.messageHandler?.(rawMessage, reply, {
      signal: abortController.signal,
      startKeepalive
    })
  }
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => {
      server.off('error', reject)
      resolve()
    })
  })
}
