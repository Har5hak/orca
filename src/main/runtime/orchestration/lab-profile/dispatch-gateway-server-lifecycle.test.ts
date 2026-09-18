import { createHash } from 'node:crypto'
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintLabGatewayPolicy, type LabGatewayBinding } from './dispatch-gateway-policy'
import {
  LabDispatchGatewayServer,
  type LabGatewayCanonicalLifecycle,
  type LabGatewayRpcInvocation,
  type LabDispatchGatewayServerOptions,
  type LabDispatchGatewayServerTestHooks
} from './dispatch-gateway-server'

const BINDING: LabGatewayBinding = {
  runId: 'run_757',
  taskId: 'task_757',
  dispatchId: 'dispatch_757',
  terminalHandle: 'term_757',
  terminalPaneKey: 'pane_757'
}
const PROCESS_INCARNATION = 'proc_757'
const DISPATCH_CAPABILITY = `dcap_${'D'.repeat(43)}`
const ENTROPY = new Uint8Array(32).fill(7)

type WireRecord = Readonly<Record<string, unknown>>

let directory = ''
let endpoint = ''
let server: LabDispatchGatewayServer | null = null
let credential = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-lab-gateway-lifecycle-'))
  endpoint = join(directory, 'gateway.sock')
})

afterEach(async () => {
  await server?.stop().catch(() => undefined)
  server = null
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('laboratory gateway lifecycle serialization', () => {
  it('keeps authority dark until endpoint attestation and receipt commit finish', async () => {
    const endpointPublished = createBarrier()
    const allowActivation = createBarrier()
    const invokeRpc = vi.fn(async () => ({ accepted: true }))
    server = createGateway(invokeRpc, {
      socketLifecycle: {
        afterEndpointPublished: async () => {
          endpointPublished.release()
          await allowActivation.wait
        }
      }
    })

    const startPromise = server.start()
    await endpointPublished.wait
    const doneRequest = request('worker.done', { outcome: 'succeeded', subject: 'done' })

    await expect(sendFrame(doneRequest)).resolves.toMatchObject(failure('gateway_not_ready'))
    expect(invokeRpc).not.toHaveBeenCalled()

    allowActivation.release()
    await expect(startPromise).resolves.toMatchObject({ dispatchId: BINDING.dispatchId })
    await expect(sendFrame(doneRequest)).resolves.toMatchObject({ ok: true })
    expect(invokeRpc).toHaveBeenCalledOnce()
  })

  it('rejects activation when the published endpoint is replaced before receipt commit', async () => {
    let replacementDevice: bigint | null = null
    let replacementInode: bigint | null = null
    const invokeRpc = vi.fn(async () => ({ unreachable: true }))
    server = createGateway(invokeRpc, {
      socketLifecycle: {
        afterEndpointPublished: async () => {
          await unlink(endpoint)
          await writeFile(endpoint, 'public-replacement', { mode: 0o600 })
          const replacement = await lstat(endpoint, { bigint: true })
          replacementDevice = replacement.dev
          replacementInode = replacement.ino
        }
      }
    })

    await expect(server.start()).rejects.toThrow('transport cleanup did not complete')

    const after = await lstat(endpoint, { bigint: true })
    expect(replacementDevice).not.toBeNull()
    expect(after.dev).toBe(replacementDevice)
    expect(after.ino).toBe(replacementInode)
    expect(after.isFile()).toBe(true)
    expect(await readFile(endpoint, 'utf8')).toBe('public-replacement')
    expect(invokeRpc).not.toHaveBeenCalled()
  })

  it('uses lstat and refuses a symlink substituted for the published endpoint', async () => {
    let backingEndpoint = ''
    server = createGateway(
      vi.fn(async () => ({ unreachable: true })),
      {
        socketLifecycle: {
          afterEndpointPublished: async () => {
            backingEndpoint = await findBackingEndpoint()
            await unlink(endpoint)
            await symlink(backingEndpoint, endpoint)
          }
        }
      }
    )

    await expect(server.start()).rejects.toThrow('transport cleanup did not complete')

    expect((await lstat(endpoint)).isSymbolicLink()).toBe(true)
    expect(await readlink(endpoint)).toBe(backingEndpoint)
  })

  it('revokes and quarantines a replaced backing name before final attestation', async () => {
    const custodyEndpoint = join(directory, 'custody.sock')
    let backingEndpoint = ''
    const invokeRpc = vi.fn(async () => ({ unreachable: true }))
    server = createGateway(invokeRpc, {
      socketLifecycle: {
        afterBackingListenBeforeAttest: async (candidate) => {
          backingEndpoint = candidate
          await link(candidate, custodyEndpoint)
          await unlink(candidate)
          await writeFile(candidate, 'private-replacement', { mode: 0o600 })
        }
      }
    })

    await expect(server.start()).rejects.toThrow('transport cleanup did not complete')
    expect(await readFile(backingEndpoint, 'utf8')).toBe('private-replacement')
    expect(invokeRpc).not.toHaveBeenCalled()
    await expect(server.stop()).rejects.toThrow('listener quarantined without unsafe close')

    await unlink(backingEndpoint)
    await link(custodyEndpoint, backingEndpoint)
    await unlink(custodyEndpoint)
    await expect(server.stop()).resolves.toBeUndefined()
  })

  it('revokes authority and aborts in-flight RPC before unsafe cleanup fails', async () => {
    const invocationEntered = createBarrier()
    let invocationAborted = false
    const invokeRpc = vi.fn(async (invocation: LabGatewayRpcInvocation) => {
      invocation.signal.addEventListener(
        'abort',
        () => {
          invocationAborted = true
        },
        { once: true }
      )
      invocationEntered.release()
      await waitForAbort(invocation.signal)
      return { unreachable: true }
    })
    server = createGateway(invokeRpc)
    await server.start()
    const responsePromise = sendFrame(request('worker.status'))
    await invocationEntered.wait

    const backingEndpoint = await findBackingEndpoint()
    await unlink(backingEndpoint)
    await writeFile(backingEndpoint, 'replacement', { mode: 0o600 })

    const failedStop = server.stop()
    expect(invocationAborted).toBe(true)
    await expect(failedStop).rejects.toThrow('backing identity changed')
    await expect(responsePromise).resolves.toMatchObject(failure('credential_revoked'))
    await expect(sendFrame(request('worker.status'))).resolves.toMatchObject(
      failure('credential_revoked')
    )
    expect(invokeRpc).toHaveBeenCalledOnce()

    await unlink(backingEndpoint)
    await link(endpoint, backingEndpoint)
    await expect(server.stop()).resolves.toBeUndefined()
  })

  it('blocks invocation when authority is revoked during lifecycle resolution', async () => {
    const resolutionEntered = createBarrier()
    const allowResolution = createBarrier()
    const invokeRpc = vi.fn(async () => ({ unreachable: true }))
    server = createGateway(invokeRpc, {}, async () => {
      resolutionEntered.release()
      await allowResolution.wait
      return activeLifecycle()
    })
    await server.start()
    const responsePromise = sendFrame(request('worker.status'))
    await resolutionEntered.wait

    const backingEndpoint = await findBackingEndpoint()
    await unlink(backingEndpoint)
    await writeFile(backingEndpoint, 'replacement', { mode: 0o600 })
    await expect(server.stop()).rejects.toThrow('backing identity changed')

    allowResolution.release()
    await expect(responsePromise).resolves.toMatchObject(failure('credential_revoked'))
    expect(invokeRpc).not.toHaveBeenCalled()

    await unlink(backingEndpoint)
    await link(endpoint, backingEndpoint)
    await expect(server.stop()).resolves.toBeUndefined()
  })

  it('coalesces concurrent start and stop without issuing a dead-server receipt', async () => {
    const endpointPublished = createBarrier()
    const allowStartToFinish = createBarrier()
    const hooks: LabDispatchGatewayServerTestHooks = {
      socketLifecycle: {
        afterEndpointPublished: async () => {
          endpointPublished.release()
          await allowStartToFinish.wait
        }
      }
    }
    server = createGateway(
      vi.fn(async () => ({ accepted: true })),
      hooks
    )

    const firstStart = server.start()
    const secondStart = server.start()
    expect(secondStart).toBe(firstStart)
    await endpointPublished.wait

    let stopSettled = false
    const firstStop = server.stop()
    const observedStop = firstStop.finally(() => {
      stopSettled = true
    })
    const secondStop = server.stop()
    expect(secondStop).toBe(firstStop)
    await Promise.resolve()
    expect(stopSettled).toBe(false)

    allowStartToFinish.release()
    await expect(firstStart).rejects.toThrow('stopped while starting')
    await expect(observedStop).resolves.toBeUndefined()
    await expect(server.start()).rejects.toThrow('authority has been revoked')
    await expect(connectOnce()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('revokes authority when start and its immediate cleanup both fail', async () => {
    let allowClose = false
    const invokeRpc = vi.fn(async () => ({ unreachable: true }))
    server = createGateway(invokeRpc, {
      socketLifecycle: {
        afterEndpointPublished: () => {
          throw new Error('injected start failure')
        },
        beforeCloseAttempt: () => {
          if (!allowClose) {
            throw new Error('injected cleanup failure')
          }
        }
      }
    })

    await expect(server.start()).rejects.toThrow('transport cleanup did not complete')
    await expect(sendFrame(request('worker.status'))).resolves.toMatchObject(
      failure('credential_revoked')
    )
    expect(invokeRpc).not.toHaveBeenCalled()

    allowClose = true
    await expect(server.stop()).resolves.toBeUndefined()
  })
})

function createGateway(
  invokeRpc: LabDispatchGatewayServerOptions['invokeRpc'],
  hooks: LabDispatchGatewayServerTestHooks = {},
  resolveLifecycle: LabDispatchGatewayServerOptions['resolveLifecycle'] = async () =>
    activeLifecycle()
): LabDispatchGatewayServer {
  const minted = mintLabGatewayPolicy(BINDING, () => ENTROPY)
  credential = minted.credential
  return new LabDispatchGatewayServer(
    {
      endpoint,
      policy: minted.policy,
      processIncarnation: PROCESS_INCARNATION,
      dispatchCapability: DISPATCH_CAPABILITY,
      resolveLifecycle,
      invokeRpc
    },
    hooks
  )
}

function activeLifecycle(): LabGatewayCanonicalLifecycle {
  return {
    binding: BINDING,
    processIncarnation: PROCESS_INCARNATION,
    dispatchCapabilitySha256: createHash('sha256').update(DISPATCH_CAPABILITY).digest('hex'),
    authorityState: 'active'
  }
}

async function findBackingEndpoint(): Promise<string> {
  const backingName = (await readdir(directory)).find((name) => name !== 'gateway.sock')
  if (!backingName) {
    throw new Error('Private laboratory socket binding was not created')
  }
  return join(directory, backingName)
}

function request(operation: string, params?: unknown): WireRecord {
  return {
    id: `request_${operation}`,
    credential,
    operation,
    ...(params === undefined ? {} : { params })
  }
}

function failure(reason: string) {
  return {
    ok: false,
    error: {
      code: 'lab_gateway_refused',
      data: expect.objectContaining({ reason })
    }
  }
}

async function sendFrame(wireRequest: WireRecord): Promise<WireRecord> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('connect', () => socket.write(`${JSON.stringify(wireRequest)}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      const parsed: unknown = JSON.parse(buffer.slice(0, newline))
      if (!isWireRecord(parsed)) {
        reject(new Error('Gateway returned a non-object frame'))
        socket.destroy()
        return
      }
      resolve(parsed)
      socket.destroy()
    })
  })
}

async function connectOnce(): Promise<void> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    socket.once('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.once('error', reject)
  })
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error('aborted')
  }
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

function createBarrier(): Readonly<{ wait: Promise<void>; release: () => void }> {
  let release = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

function isWireRecord(value: unknown): value is WireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
