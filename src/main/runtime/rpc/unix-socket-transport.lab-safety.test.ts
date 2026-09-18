import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LabUnixSocketLifecycleHooks } from './lab-unix-socket-lifecycle'
import { UnixSocketTransport } from './unix-socket-transport'

let directory = ''
let endpoint = ''
let transport: UnixSocketTransport | null = null

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-lab-socket-safety-'))
  endpoint = join(directory, 'gateway.sock')
})

afterEach(async () => {
  await transport?.stop().catch(() => undefined)
  transport = null
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('laboratory Unix socket lifecycle', () => {
  it('refuses and preserves a pre-existing endpoint', async () => {
    await writeFile(endpoint, 'pre-existing', { mode: 0o600 })
    const original = await identity(endpoint)
    transport = createLabTransport()

    await expect(transport.start()).rejects.toThrow('must not already exist')

    expect(await readFile(endpoint, 'utf8')).toBe('pre-existing')
    expect(await identity(endpoint)).toEqual(original)
    expect(await readdir(directory)).toEqual(['gateway.sock'])
  })

  it('preserves an endpoint inserted between the absence check and atomic publish', async () => {
    const entered = createBarrier()
    const proceed = createBarrier()
    transport = createLabTransport({
      afterEndpointAbsent: async () => {
        entered.release()
        await proceed.wait
      }
    })

    const startPromise = transport.start()
    await entered.wait
    await writeFile(endpoint, 'race-inserted', { mode: 0o600, flag: 'wx' })
    proceed.release()

    await expect(startPromise).rejects.toBeInstanceOf(Error)
    expect(await readFile(endpoint, 'utf8')).toBe('race-inserted')
    expect(await readdir(directory)).toEqual(['gateway.sock'])
  })

  it('coalesces start and makes stop wait for an in-progress bind', async () => {
    const entered = createBarrier()
    const proceed = createBarrier()
    transport = createLabTransport({
      afterEndpointAbsent: async () => {
        entered.release()
        await proceed.wait
      }
    })

    const firstStart = transport.start()
    const secondStart = transport.start()
    expect(secondStart).toBe(firstStart)
    await entered.wait

    let stopSettled = false
    const firstStop = transport.stop()
    const observedStop = firstStop.finally(() => {
      stopSettled = true
    })
    const secondStop = transport.stop()
    expect(secondStop).toBe(firstStop)
    await Promise.resolve()
    expect(stopSettled).toBe(false)

    proceed.release()
    await expect(firstStart).resolves.toBeUndefined()
    await expect(observedStop).resolves.toBeUndefined()
    await expect(connectOnce()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('quarantines a listener whose backing name changes before final attestation', async () => {
    const custodyEndpoint = join(directory, 'custody.sock')
    let backingEndpoint = ''
    transport = createLabTransport({
      afterBackingListenBeforeAttest: async (candidate) => {
        backingEndpoint = candidate
        await link(candidate, custodyEndpoint)
        await unlink(candidate)
        await writeFile(candidate, 'pre-attestation-replacement', { mode: 0o600 })
      }
    })

    await expect(transport.start()).rejects.toThrow(
      'backing identity changed before attestation; listener quarantined without unsafe close'
    )

    const replacement = await identity(backingEndpoint)
    expect(replacement).toEqual(expect.objectContaining({ mode: 0o600n, type: 'file' }))
    expect(await readFile(backingEndpoint, 'utf8')).toBe('pre-attestation-replacement')
    await expect(transport.stop()).rejects.toThrow('listener quarantined without unsafe close')
    expect(await identity(backingEndpoint)).toEqual(replacement)

    // Restoring the captured exact socket inode makes cleanup deterministic;
    // without that identity restoration the lifecycle remains quarantined.
    await unlink(backingEndpoint)
    await link(custodyEndpoint, backingEndpoint)
    await unlink(custodyEndpoint)
    await expect(transport.stop()).resolves.toBeUndefined()
  })

  it('closes an exact socket while retaining its attested public identity', async () => {
    transport = createLabTransport()
    transport.onMessage((message, reply) => reply(`received:${message}`))
    await transport.start()
    const before = await identity(endpoint)

    await expect(sendFrame('ping')).resolves.toBe('received:ping')
    await expect(transport.stop()).resolves.toBeUndefined()

    const after = await identity(endpoint)
    expect(before).toEqual(expect.objectContaining({ mode: 0o600n, type: 'socket' }))
    expect(after).toEqual(before)
    await expect(connectOnce()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('closes only the private binding and preserves a replacement before stop', async () => {
    transport = createLabTransport()
    await transport.start()
    await unlink(endpoint)
    await writeFile(endpoint, 'replacement', { mode: 0o600 })
    const replacement = await identity(endpoint)

    await expect(transport.stop()).rejects.toThrow('public endpoint identity was replaced')

    expect(await readFile(endpoint, 'utf8')).toBe('replacement')
    expect(await identity(endpoint)).toEqual(replacement)
  })

  it('refuses to close over a replaced private binding name', async () => {
    transport = createLabTransport()
    await transport.start()
    const backingName = (await readdir(directory)).find((name) => name !== 'gateway.sock')
    expect(backingName).toBeDefined()
    if (!backingName) {
      throw new Error('Private laboratory socket binding was not created')
    }
    const backingEndpoint = join(directory, backingName)
    await unlink(backingEndpoint)
    await writeFile(backingEndpoint, 'private-replacement', { mode: 0o600 })
    const replacement = await identity(backingEndpoint)

    await expect(transport.stop()).rejects.toThrow('backing identity changed')

    expect(await identity(backingEndpoint)).toEqual(replacement)
    expect(await readFile(backingEndpoint, 'utf8')).toBe('private-replacement')

    // Restore the exact socket inode so afterEach can close without deleting
    // the replacement that this assertion protects.
    await unlink(backingEndpoint)
    await link(endpoint, backingEndpoint)
  })

  it('retains cleanup custody and retries a failed close attempt', async () => {
    let attempts = 0
    transport = createLabTransport({
      beforeCloseAttempt: () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('injected close failure')
        }
      }
    })
    transport.onMessage((message, reply) => reply(`received:${message}`))
    await transport.start()

    await expect(transport.stop()).rejects.toThrow('injected close failure')
    await expect(sendFrame('still-live')).resolves.toBe('received:still-live')
    await expect(transport.stop()).resolves.toBeUndefined()

    expect(attempts).toBe(2)
    await expect(connectOnce()).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('requires the socket namespace to remain the attested owner-only directory', async () => {
    transport = createLabTransport()
    await transport.start()
    await chmod(directory, 0o755)

    await expect(transport.stop()).rejects.toThrow('parent identity changed')
    await expect(connectOnce()).resolves.toBeUndefined()

    await chmod(directory, 0o700)
    await expect(transport.stop()).resolves.toBeUndefined()
  })

  it('does not delete a sibling when closing the exact endpoint or a replacement', async () => {
    const sibling = join(directory, 'sibling.txt')
    await writeFile(sibling, 'keep-sibling', { mode: 0o600 })
    const siblingIdentity = await identity(sibling)
    transport = createLabTransport()
    await transport.start()
    await unlink(endpoint)
    await writeFile(endpoint, 'keep-replacement', { mode: 0o600 })
    const replacementIdentity = await identity(endpoint)

    await expect(transport.stop()).rejects.toThrow('public endpoint identity was replaced')

    expect(await identity(sibling)).toEqual(siblingIdentity)
    expect(await readFile(sibling, 'utf8')).toBe('keep-sibling')
    expect(await identity(endpoint)).toEqual(replacementIdentity)
    expect(await readFile(endpoint, 'utf8')).toBe('keep-replacement')
  })
})

function createLabTransport(hooks: LabUnixSocketLifecycleHooks = {}): UnixSocketTransport {
  return UnixSocketTransport.forLaboratoryGateway(endpoint, hooks)
}

function createBarrier(): Readonly<{ wait: Promise<void>; release: () => void }> {
  let release = (): void => undefined
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

async function identity(path: string) {
  const stats = await lstat(path, { bigint: true })
  return {
    device: stats.dev,
    inode: stats.ino,
    uid: stats.uid,
    mode: stats.mode & 0o7777n,
    type: stats.isSocket() ? 'socket' : stats.isFile() ? 'file' : 'other'
  }
}

async function sendFrame(message: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('connect', () => socket.write(`${message}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      resolve(buffer.slice(0, newline))
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
