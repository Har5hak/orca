import { randomBytes } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { link } from 'node:fs/promises'
import type { Server } from 'node:net'
import { dirname, join } from 'node:path'
import {
  publicEndpointAttestation,
  readEndpointEvidence,
  requireOwnedMode600Socket,
  requireOwnedMode700Directory,
  sameEndpointIdentity,
  sameOptionalEndpointIdentity,
  type LabUnixSocketEndpointAttestation,
  type UnixEndpointEvidence
} from './lab-unix-socket-evidence'

export type {
  LabUnixSocketEndpointAttestation,
  LabUnixSocketEndpointEvidence
} from './lab-unix-socket-evidence'

type LabUnixSocketBinding = Readonly<{
  parentIdentity: UnixEndpointEvidence
  backingEndpoint: string
  backingIdentity: UnixEndpointEvidence | null
  backingAttested: boolean
  publicIdentity: UnixEndpointEvidence | null
}>

export type LabUnixSocketLifecycleHooks = Readonly<{
  afterEndpointAbsent?: () => void | Promise<void>
  afterBackingListenBeforeAttest?: (backingEndpoint: string) => void | Promise<void>
  afterEndpointPublished?: () => void | Promise<void>
  beforeCloseAttempt?: () => void | Promise<void>
}>

/**
 * Opt-in endpoint ownership for disposable laboratory gateways.
 *
 * Node unlinks the pathname passed to listen() during Server.close(), even if
 * another file has replaced it. This lifecycle binds a private random name,
 * then atomically hard-links that socket inode at the public endpoint. Close
 * can only auto-unlink the private name. The public name is deliberately
 * retained for identity-fenced disposable-runtime cleanup.
 */
export class LabUnixSocketLifecycle {
  private readonly endpoint: string
  private readonly hooks: LabUnixSocketLifecycleHooks
  private binding: LabUnixSocketBinding | null = null
  private definitivelyClosed = false
  private quarantined = false
  private terminalError: Error | null = null

  constructor(endpoint: string, hooks: LabUnixSocketLifecycleHooks = {}) {
    this.endpoint = endpoint
    this.hooks = hooks
  }

  get hasCleanupCustody(): boolean {
    return this.binding !== null
  }

  get isDefinitivelyClosed(): boolean {
    return this.definitivelyClosed
  }

  async attestPublishedEndpoint(): Promise<LabUnixSocketEndpointAttestation> {
    const binding = this.binding
    if (!binding?.backingAttested || !binding.backingIdentity || !binding.publicIdentity) {
      throw new Error('Laboratory Unix socket endpoint is not ready for attestation')
    }
    if (this.quarantined || this.definitivelyClosed) {
      throw new Error('Laboratory Unix socket endpoint is not active')
    }
    const parent = await readEndpointEvidence(dirname(this.endpoint))
    if (!sameEndpointIdentity(parent, binding.parentIdentity)) {
      throw new Error('Laboratory Unix socket parent identity changed before activation')
    }
    const backing = await readEndpointEvidence(binding.backingEndpoint)
    if (!sameEndpointIdentity(backing, binding.backingIdentity)) {
      throw new Error('Laboratory Unix socket backing identity changed before activation')
    }
    // lstat is intentional: a symlink to the original inode is not the published endpoint.
    const published = await requireOwnedMode600Socket(this.endpoint)
    if (!sameEndpointIdentity(published, binding.publicIdentity)) {
      throw new Error('Laboratory Unix socket public endpoint identity changed before activation')
    }
    return publicEndpointAttestation(published)
  }

  async start(server: Server, closeServer: () => Promise<void>): Promise<void> {
    if (this.binding) {
      throw new Error('Laboratory Unix socket lifecycle already owns a binding')
    }
    // A 0700 parent excludes other UIDs; Node has no inode-conditional close for same-UID races.
    const parentIdentity = await requireOwnedMode700Directory(dirname(this.endpoint))
    if ((await readEndpointEvidence(this.endpoint)) !== null) {
      throw new Error('Laboratory Unix socket endpoint must not already exist')
    }
    await this.hooks.afterEndpointAbsent?.()

    // Keep this basename no longer than `gateway.sock`: macOS limits a
    // sockaddr_un pathname to 103 bytes and the disposable root can be nested.
    const backingEndpoint = join(dirname(this.endpoint), `.${randomBytes(5).toString('hex')}`)
    if ((await readEndpointEvidence(backingEndpoint)) !== null) {
      throw new Error('Laboratory Unix socket backing endpoint collision')
    }

    await listen(server, backingEndpoint)
    this.binding = Object.freeze({
      parentIdentity,
      backingEndpoint,
      backingIdentity: null,
      backingAttested: false,
      publicIdentity: null
    })
    try {
      chmodSync(backingEndpoint, 0o600)
      // Capture provisional cleanup custody before the deterministic race
      // hook, then require the same lstat identity again before publication.
      // A mismatch is quarantined: calling Server.close() would make libuv
      // unlink the replacement by name.
      const provisionalBackingIdentity = await requireOwnedMode600Socket(backingEndpoint)
      this.binding = Object.freeze({
        ...this.binding,
        backingIdentity: provisionalBackingIdentity
      })
      await this.hooks.afterBackingListenBeforeAttest?.(backingEndpoint)
      const backingIdentity = await requireOwnedMode600Socket(backingEndpoint)
      if (!sameEndpointIdentity(provisionalBackingIdentity, backingIdentity)) {
        throw new Error('Laboratory Unix socket backing identity changed before attestation')
      }
      this.binding = Object.freeze({
        ...this.binding,
        backingIdentity,
        backingAttested: true
      })
      await link(backingEndpoint, this.endpoint)
      const publicIdentity = await requireOwnedMode600Socket(this.endpoint)
      if (!sameEndpointIdentity(backingIdentity, publicIdentity)) {
        throw new Error('Laboratory Unix socket public endpoint identity mismatch')
      }

      this.binding = Object.freeze({
        parentIdentity,
        backingEndpoint,
        backingIdentity,
        backingAttested: true,
        publicIdentity
      })
      await this.hooks.afterEndpointPublished?.()
    } catch (error) {
      const binding = this.binding
      if (!binding.backingIdentity) {
        throw this.quarantine(server, error, 'backing identity could not be observed')
      }
      if (!binding.backingAttested) {
        const currentBacking = await readEndpointEvidence(binding.backingEndpoint)
        if (!sameEndpointIdentity(currentBacking, binding.backingIdentity)) {
          throw this.quarantine(server, error, 'backing identity changed before attestation')
        }
        this.binding = Object.freeze({ ...binding, backingAttested: true })
      }
      try {
        await this.closeBinding(closeServer)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Laboratory Unix socket start failed and cleanup did not complete'
        )
      }
      throw error
    }
  }

  async stop(closeServer: () => Promise<void>): Promise<void> {
    if (this.definitivelyClosed) {
      if (this.terminalError) {
        throw this.terminalError
      }
      return
    }
    const binding = this.binding
    if (!binding) {
      throw new Error('Laboratory Unix socket binding evidence is unavailable')
    }
    if (!binding.backingIdentity) {
      throw new Error('Laboratory Unix socket backing identity was never attested')
    }

    if (this.quarantined) {
      const restoredBacking = await readEndpointEvidence(binding.backingEndpoint)
      if (!sameEndpointIdentity(restoredBacking, binding.backingIdentity)) {
        throw this.terminalError ?? new Error('Laboratory Unix socket listener is quarantined')
      }
      this.binding = Object.freeze({ ...binding, backingAttested: true })
      this.quarantined = false
      this.terminalError = null
    }

    const parentBeforeClose = await readEndpointEvidence(dirname(this.endpoint))
    if (!sameEndpointIdentity(parentBeforeClose, binding.parentIdentity)) {
      throw new Error('Laboratory Unix socket parent identity changed; refusing unsafe close')
    }
    const backingBeforeClose = await readEndpointEvidence(binding.backingEndpoint)
    if (!sameEndpointIdentity(backingBeforeClose, binding.backingIdentity)) {
      // Node's close path would unlink whatever now occupies backingEndpoint.
      // Refuse to close rather than deleting an unowned replacement by name.
      throw new Error('Laboratory Unix socket backing identity changed; refusing unsafe close')
    }
    const publicBeforeClose = await readEndpointEvidence(this.endpoint)

    try {
      await this.closeBinding(closeServer)
    } catch (error) {
      const backingAfterFailure = await readEndpointEvidence(binding.backingEndpoint)
      if (backingAfterFailure === null) {
        this.definitivelyClosed = true
        this.terminalError = new Error(
          'Laboratory Unix socket close failed after the backing endpoint disappeared'
        )
      }
      throw error
    }

    const backingAfterClose = await readEndpointEvidence(binding.backingEndpoint)
    if (backingAfterClose !== null) {
      this.terminalError = new Error('Laboratory Unix socket backing endpoint survived close')
      throw this.terminalError
    }
    if (!binding.publicIdentity) {
      return
    }
    const publicAfterClose = await readEndpointEvidence(this.endpoint)
    if (!sameOptionalEndpointIdentity(publicBeforeClose, publicAfterClose)) {
      this.terminalError = new Error(
        'Laboratory Unix socket public endpoint changed while stopping'
      )
      throw this.terminalError
    }
    if (!sameEndpointIdentity(publicAfterClose, binding.publicIdentity)) {
      this.terminalError = new Error('Laboratory Unix socket public endpoint identity was replaced')
      throw this.terminalError
    }
  }

  private async closeBinding(closeServer: () => Promise<void>): Promise<void> {
    await this.hooks.beforeCloseAttempt?.()
    await closeServer()
    this.definitivelyClosed = true
  }

  private quarantine(server: Server, cause: unknown, reason: string): Error {
    server.unref()
    this.quarantined = true
    this.terminalError = new AggregateError(
      [cause],
      `Laboratory Unix socket ${reason}; listener quarantined without unsafe close`
    )
    return this.terminalError
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
