import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintLabGatewayPolicy, type LabGatewayBinding } from './dispatch-gateway-policy'
import {
  LabDispatchGatewayServer,
  type LabGatewayAuditEvent,
  type LabGatewayCanonicalLifecycle,
  type LabGatewayServerReceipt,
  type LabDispatchGatewayServerOptions
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
let receipt: LabGatewayServerReceipt
let canonical: LabGatewayCanonicalLifecycle | null
let auditEvents: LabGatewayAuditEvent[]
let resolveLifecycle: ReturnType<typeof vi.fn<LabDispatchGatewayServerOptions['resolveLifecycle']>>
let invokeRpc: ReturnType<typeof vi.fn<LabDispatchGatewayServerOptions['invokeRpc']>>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-lab-gateway-'))
  endpoint = join(directory, 'gateway.sock')
  const minted = mintLabGatewayPolicy(BINDING, () => ENTROPY)
  credential = minted.credential
  canonical = activeLifecycle()
  auditEvents = []
  resolveLifecycle = vi.fn<LabDispatchGatewayServerOptions['resolveLifecycle']>(
    async () => canonical
  )
  invokeRpc = vi.fn<LabDispatchGatewayServerOptions['invokeRpc']>(async () => ({
    accepted: true
  }))
  server = new LabDispatchGatewayServer({
    endpoint,
    policy: minted.policy,
    processIncarnation: PROCESS_INCARNATION,
    dispatchCapability: DISPATCH_CAPABILITY,
    resolveLifecycle,
    invokeRpc,
    audit: (event) => auditEvents.push(event)
  })
  receipt = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = null
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('per-Dispatch laboratory gateway server', () => {
  it('binds an actual mode-0600 Unix socket and invokes all six allowlisted operations', async () => {
    expect((await stat(endpoint)).mode & 0o777).toBe(0o600)
    const requests = [
      request('worker.status'),
      request('worker.check', { wait: false }),
      request('worker.heartbeat', { subject: 'working' }),
      request('worker.ask', { question: 'Proceed?' }),
      request('worker.reply.consume', { questionId: 'question_1' }),
      request('worker.done', { outcome: 'succeeded', subject: 'done' })
    ]

    for (const wireRequest of requests) {
      await expect(sendFrame(wireRequest)).resolves.toMatchObject({ ok: true })
    }

    expect(resolveLifecycle).toHaveBeenCalledTimes(6)
    expect(resolveLifecycle).toHaveBeenCalledWith(BINDING.dispatchId)
    expect(invokeRpc).toHaveBeenCalledTimes(6)
    expect(invokeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchCapability: DISPATCH_CAPABILITY,
        processIncarnation: PROCESS_INCARNATION,
        rpc: {
          method: 'orchestration.workerShow',
          params: { dispatch: BINDING.dispatchId }
        }
      })
    )
  })

  it('keeps the Dispatch capability server-side and omits both secrets from receipts and logs', async () => {
    const wireRequest = request('worker.status')
    expect(JSON.stringify(wireRequest)).not.toContain(DISPATCH_CAPABILITY)

    await expect(sendFrame(wireRequest)).resolves.toMatchObject({
      ok: true,
      receipt: { dcapCustody: 'server-only' }
    })

    const serializedEvidence = JSON.stringify({ receipt, auditEvents })
    expect(serializedEvidence).not.toContain(credential)
    expect(serializedEvidence).not.toContain(DISPATCH_CAPABILITY)
    expect(serializedEvidence).not.toMatch(/authToken|runtimeToken|sharedToken|ALL_RPC_METHODS/u)
  })

  it('rejects raw methods, broad RPC operations, and caller-supplied identities', async () => {
    await expect(
      sendFrame({ ...request('worker.status'), method: 'orchestration.workerShow' })
    ).resolves.toMatchObject(failure('raw_method_forbidden'))
    await expect(sendFrame(request('orchestration.send'))).resolves.toMatchObject(
      failure('arbitrary_send_forbidden')
    )
    await expect(
      sendFrame(request('worker.heartbeat', { subject: 'working', dispatchId: 'foreign' }))
    ).resolves.toMatchObject(failure('cross_dispatch_identity'))
    await expect(
      sendFrame(request('worker.heartbeat', { subject: 'working', runId: BINDING.runId }))
    ).resolves.toMatchObject(failure('caller_identity_forbidden'))
    expect(invokeRpc).not.toHaveBeenCalled()
  })

  it('loads canonical lifecycle on every admitted request and fails closed after revocation', async () => {
    await expect(sendFrame(request('worker.status'))).resolves.toMatchObject({ ok: true })
    canonical = { ...activeLifecycle(), authorityState: 'revoked' }

    await expect(sendFrame(request('worker.status'))).resolves.toMatchObject(
      failure('credential_revoked')
    )

    expect(resolveLifecycle).toHaveBeenCalledTimes(2)
    expect(invokeRpc).toHaveBeenCalledTimes(1)
  })

  it('accepts worker.done once and refuses replay before another upstream invocation', async () => {
    const done = request('worker.done', { outcome: 'succeeded', subject: 'done' })

    await expect(sendFrame(done)).resolves.toMatchObject({ ok: true })
    await expect(sendFrame(done)).resolves.toMatchObject(failure('worker_done_already_accepted'))

    expect(resolveLifecycle).toHaveBeenCalledOnce()
    expect(invokeRpc).toHaveBeenCalledOnce()
  })

  it('serializes concurrent worker.done requests at the in-memory policy boundary', async () => {
    const done = request('worker.done', { outcome: 'succeeded', subject: 'done' })

    const responses = await Promise.all([sendFrame(done), sendFrame(done)])
    const refusals = responses.filter((response) => response.ok === false)

    expect(responses.filter((response) => response.ok === true)).toHaveLength(1)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject(failure('worker_done_already_accepted'))
    expect(invokeRpc).toHaveBeenCalledOnce()
  })

  it('keeps worker.done terminal when the upstream outcome is unknown', async () => {
    const done = request('worker.done', { outcome: 'succeeded', subject: 'done' })
    invokeRpc.mockRejectedValueOnce(new Error('injected upstream loss'))

    await expect(sendFrame(done)).resolves.toMatchObject(failure('upstream_failed'))
    await expect(sendFrame(done)).resolves.toMatchObject(failure('worker_done_already_accepted'))

    expect(invokeRpc).toHaveBeenCalledOnce()
  })

  it.each(canonicalRefusalCases())(
    'refuses canonical lifecycle state: %s',
    async (_label, state, reason) => {
      canonical = state

      await expect(sendFrame(request('worker.status'))).resolves.toMatchObject(failure(reason))
      expect(resolveLifecycle).toHaveBeenCalledOnce()
      expect(invokeRpc).not.toHaveBeenCalled()
    }
  )

  it('rejects a wrong gateway credential before consulting lifecycle state', async () => {
    await expect(
      sendFrame({ ...request('worker.status'), credential: 'lgw1_wrong' })
    ).resolves.toMatchObject(failure('credential_invalid'))
    expect(resolveLifecycle).not.toHaveBeenCalled()
    expect(invokeRpc).not.toHaveBeenCalled()
  })
})

function activeLifecycle(): LabGatewayCanonicalLifecycle {
  return {
    binding: BINDING,
    processIncarnation: PROCESS_INCARNATION,
    dispatchCapabilitySha256: sha256(DISPATCH_CAPABILITY),
    authorityState: 'active'
  }
}

function canonicalRefusalCases(): [string, LabGatewayCanonicalLifecycle | null, string][] {
  return [
    ['invalid', null, 'dispatch_invalid'],
    ['settled', { ...activeLifecycle(), authorityState: 'settled' }, 'dispatch_settled'],
    [
      'process replacement',
      { ...activeLifecycle(), processIncarnation: 'proc_replacement' },
      'process_incarnation_mismatch'
    ],
    [
      'Dispatch capability replacement',
      { ...activeLifecycle(), dispatchCapabilitySha256: '0'.repeat(64) },
      'dispatch_capability_invalid'
    ],
    [
      'cross-Dispatch resolver result',
      {
        ...activeLifecycle(),
        binding: { ...BINDING, dispatchId: 'dispatch_foreign' }
      },
      'cross_dispatch_identity'
    ]
  ]
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
      const line = buffer.slice(0, newline)
      const parsed: unknown = JSON.parse(line)
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

function isWireRecord(value: unknown): value is WireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
