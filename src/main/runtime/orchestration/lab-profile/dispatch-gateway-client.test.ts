import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LabGatewayClientFailure, callLabDispatchGateway } from './dispatch-gateway-client'
import { mintLabGatewayPolicy, type LabGatewayBinding } from './dispatch-gateway-policy'
import {
  LabDispatchGatewayServer,
  type LabGatewayCanonicalLifecycle,
  type LabGatewayServerReceipt,
  type LabDispatchGatewayServerOptions
} from './dispatch-gateway-server'

const BINDING: LabGatewayBinding = {
  runId: 'run_757_client',
  taskId: 'task_757_client',
  dispatchId: 'dispatch_757_client',
  terminalHandle: 'term_757_client',
  terminalPaneKey: 'pane_757_client'
}
const PROCESS_INCARNATION = 'proc_757_client'
const DISPATCH_CAPABILITY = `dcap_${'C'.repeat(43)}`
const ENTROPY = new Uint8Array(32).fill(11)

let directory = ''
let endpoint = ''
let credential = ''
let receipt: LabGatewayServerReceipt
let server: LabDispatchGatewayServer | null = null
let invokeRpc: ReturnType<typeof vi.fn<LabDispatchGatewayServerOptions['invokeRpc']>>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-lab-gateway-client-'))
  endpoint = join(directory, 'gateway.sock')
  const minted = mintLabGatewayPolicy(BINDING, () => ENTROPY)
  credential = minted.credential
  invokeRpc = vi.fn<LabDispatchGatewayServerOptions['invokeRpc']>(async () => ({ accepted: true }))
  server = new LabDispatchGatewayServer({
    endpoint,
    policy: minted.policy,
    processIncarnation: PROCESS_INCARNATION,
    dispatchCapability: DISPATCH_CAPABILITY,
    resolveLifecycle: async () => activeLifecycle(),
    invokeRpc
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

describe.skipIf(process.platform === 'win32')('laboratory Dispatch gateway host client', () => {
  it('performs one bound call and returns only secret-free evidence', async () => {
    const result = await callLabDispatchGateway({
      endpoint,
      credential,
      operation: 'worker.status',
      expectedReceipt: receipt,
      requestId: 'status_1'
    })

    expect(result).toMatchObject({
      ok: true,
      result: { accepted: true },
      receipt: { dispatchId: BINDING.dispatchId, dcapCustody: 'server-only' }
    })
    expect(invokeRpc).toHaveBeenCalledOnce()
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
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(JSON.stringify(result)).not.toContain(DISPATCH_CAPABILITY)
  })

  it('returns a typed policy refusal without leaking or retrying the bearer', async () => {
    const result = await callLabDispatchGateway({
      endpoint,
      credential,
      operation: 'worker.heartbeat',
      params: { dispatchId: 'foreign', subject: 'working' },
      expectedReceipt: receipt,
      requestId: 'refusal_1'
    })

    expect(result).toMatchObject({ ok: false, reason: 'cross_dispatch_identity' })
    expect(invokeRpc).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(credential)
  })

  it('refuses a response whose server receipt does not match the expected gateway', async () => {
    const { receiptSha256: _receiptSha256, ...stableReceipt } = receipt
    const mismatchedStableReceipt = Object.freeze({
      ...stableReceipt,
      policyId: 'policy_for_a_different_gateway'
    })
    const wrongReceipt: LabGatewayServerReceipt = Object.freeze({
      ...mismatchedStableReceipt,
      receiptSha256: createHash('sha256')
        .update(JSON.stringify(mismatchedStableReceipt))
        .digest('hex')
    })

    await expect(
      callLabDispatchGateway({
        endpoint,
        credential,
        operation: 'worker.status',
        expectedReceipt: wrongReceipt,
        requestId: 'mismatch_1'
      })
    ).rejects.toEqual(new LabGatewayClientFailure('response_receipt_mismatch'))
    expect(invokeRpc).toHaveBeenCalledOnce()
  })

  it('does not retry terminal completion after an unknown upstream outcome', async () => {
    invokeRpc.mockRejectedValueOnce(new Error('injected upstream loss'))
    const first = await callLabDispatchGateway({
      endpoint,
      credential,
      operation: 'worker.done',
      params: { outcome: 'succeeded', subject: 'done' },
      expectedReceipt: receipt,
      requestId: 'done_1'
    })
    const second = await callLabDispatchGateway({
      endpoint,
      credential,
      operation: 'worker.done',
      params: { outcome: 'succeeded', subject: 'done' },
      expectedReceipt: receipt,
      requestId: 'done_2'
    })

    expect(first).toMatchObject({ ok: false, reason: 'upstream_failed' })
    expect(second).toMatchObject({ ok: false, reason: 'worker_done_already_accepted' })
    expect(invokeRpc).toHaveBeenCalledOnce()
  })
})

function activeLifecycle(): LabGatewayCanonicalLifecycle {
  return {
    binding: BINDING,
    processIncarnation: PROCESS_INCARNATION,
    dispatchCapabilitySha256: createHash('sha256').update(DISPATCH_CAPABILITY).digest('hex'),
    authorityState: 'active'
  }
}
