import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { LabGatewayClientFailure } from '../runtime/orchestration/lab-profile/dispatch-gateway-client'
import type { LabGatewayServerReceipt } from '../runtime/orchestration/lab-profile/dispatch-gateway-server'
import {
  claimCodexLabDynamicToolHostFactory,
  CodexLabDynamicToolHost,
  createCodexLabDynamicToolHostFactory,
  revokeCodexLabDynamicToolHostFactory
} from './codex-lab-dynamic-tool-host'

const ENDPOINT = '/private/tmp/orca-lab/runtime/dispatches/dispatch-757/gateway.sock'
const CREDENTIAL = `lgw1_${'A'.repeat(43)}`

function receipt(): LabGatewayServerReceipt {
  const endpointIdentity = Object.freeze({
    device: '1',
    inode: '757',
    uid: '501',
    mode: '0600' as const,
    type: 'socket' as const
  })
  const stable = Object.freeze({
    schema: 'orca.lab-dispatch-gateway.v1' as const,
    policyId: 'policy_757',
    dispatchId: 'dispatch-757',
    transport: 'unix' as const,
    socketMode: '0600' as const,
    endpointSha256: sha256(ENDPOINT),
    endpointIdentity,
    endpointIdentitySha256: sha256(JSON.stringify(endpointIdentity)),
    processIncarnationSha256: '1'.repeat(64),
    allowedOperations: Object.freeze([
      'worker.status',
      'worker.check',
      'worker.heartbeat',
      'worker.ask',
      'worker.reply.consume',
      'worker.done'
    ] as const),
    lifecycleSource: 'injected-per-request' as const,
    dcapCustody: 'server-only' as const
  })
  return Object.freeze({ ...stable, receiptSha256: sha256(JSON.stringify(stable)) })
}

function invocation(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    callId: 'call_757_1',
    namespace: null,
    tool: 'orca_worker_heartbeat',
    arguments: { subject: 'working', body: 'focused tests' },
    ...overrides
  }
}

describe('Codex laboratory dynamic-tool host bridge', () => {
  it('keeps gateway secrets out of the callable closure and drops revocable factory state', () => {
    const factory = createCodexLabDynamicToolHostFactory({
      endpoint: ENDPOINT,
      credential: CREDENTIAL,
      expectedReceipt: receipt()
    })

    expect(factory.toString()).not.toMatch(/binding|credential|endpoint|expectedReceipt/u)
    expect(claimCodexLabDynamicToolHostFactory(factory)).toBe(true)
    const host = factory()
    revokeCodexLabDynamicToolHostFactory(factory)

    expect(() => factory()).toThrow(/factory is revoked/i)
    host.dispose()
  })

  it('maps one validated call to the host gateway without exposing host authority', async () => {
    const callGateway = vi.fn(async () => ({
      ok: true as const,
      result: { accepted: true },
      receipt: receipt()
    }))
    const host = new CodexLabDynamicToolHost(
      { endpoint: ENDPOINT, credential: CREDENTIAL, expectedReceipt: receipt() },
      callGateway
    )

    const result = await host.invoke(invocation())

    expect(callGateway).toHaveBeenCalledOnce()
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: ENDPOINT,
        credential: CREDENTIAL,
        operation: 'worker.heartbeat',
        params: { subject: 'working', body: 'focused tests' }
      })
    )
    expect(result).toEqual({
      contentItems: [{ type: 'inputText', text: '{"ok":true,"result":{"accepted":true}}' }],
      success: true
    })
    expect(JSON.stringify(result)).not.toContain(ENDPOINT)
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL)
    expect(JSON.stringify(result)).not.toContain('policy_757')
  })

  it.each([
    [{ namespace: 'orca' }, 'unknown_namespace'],
    [{ tool: 'orca_worker_start' }, 'unknown_tool'],
    [{ arguments: { subject: 'working', dispatchId: 'foreign' } }, 'forbidden_argument'],
    [{ arguments: { subject: '' } }, 'invalid_arguments'],
    [{ callId: '../bad' }, 'call_id_invalid']
  ])(
    'refuses malformed or broadened input before gateway invocation',
    async (overrides, reason) => {
      const callGateway = vi.fn()
      const host = new CodexLabDynamicToolHost(
        { endpoint: ENDPOINT, credential: CREDENTIAL, expectedReceipt: receipt() },
        callGateway
      )

      const result = await host.invoke(invocation(overrides))

      expect(callGateway).not.toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.contentItems[0].text).toContain(`"reason":"${reason}"`)
    }
  )

  it('serializes concurrent duplicate calls before the external invocation settles', async () => {
    const pending = Promise.withResolvers<{
      ok: true
      result: { accepted: true }
      receipt: LabGatewayServerReceipt
    }>()
    const callGateway = vi.fn(() => pending.promise)
    const host = new CodexLabDynamicToolHost(
      { endpoint: ENDPOINT, credential: CREDENTIAL, expectedReceipt: receipt() },
      callGateway
    )

    const first = host.invoke(invocation())
    const duplicate = await host.invoke(invocation())
    pending.resolve({ ok: true, result: { accepted: true }, receipt: receipt() })

    expect((await first).success).toBe(true)
    expect(duplicate).toMatchObject({ success: false })
    expect(duplicate.contentItems[0].text).toContain('call_replayed')
    expect(callGateway).toHaveBeenCalledOnce()
  })

  it('does not retry an unknown gateway outcome with the same call identity', async () => {
    const callGateway = vi.fn(async () => {
      throw new LabGatewayClientFailure('outcome_unknown')
    })
    const host = new CodexLabDynamicToolHost(
      { endpoint: ENDPOINT, credential: CREDENTIAL, expectedReceipt: receipt() },
      callGateway
    )

    const first = await host.invoke(
      invocation({
        tool: 'orca_worker_done',
        arguments: {
          outcome: 'succeeded',
          subject: 'done'
        }
      })
    )
    const duplicate = await host.invoke(
      invocation({
        tool: 'orca_worker_done',
        arguments: {
          outcome: 'succeeded',
          subject: 'done'
        }
      })
    )

    expect(first.contentItems[0].text).toContain('outcome_unknown')
    expect(duplicate.contentItems[0].text).toContain('call_replayed')
    expect(callGateway).toHaveBeenCalledOnce()
  })

  it('aborts in-flight work and refuses every call after disposal', async () => {
    let observedSignal: AbortSignal | undefined
    const callGateway = vi.fn(
      (args: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          observedSignal = args.signal
          args.signal?.addEventListener(
            'abort',
            () => reject(new LabGatewayClientFailure('aborted')),
            { once: true }
          )
        })
    )
    const host = new CodexLabDynamicToolHost(
      { endpoint: ENDPOINT, credential: CREDENTIAL, expectedReceipt: receipt() },
      callGateway
    )

    const pending = host.invoke(invocation())
    host.dispose()

    expect((await pending).contentItems[0].text).toContain('aborted')
    expect(observedSignal?.aborted).toBe(true)
    expect(
      (await host.invoke(invocation({ callId: 'call_757_2' }))).contentItems[0].text
    ).toContain('host_disposed')
    expect(callGateway).toHaveBeenCalledOnce()
  })

  it('bounds provider-visible results and normalizes untrusted refusal reasons', async () => {
    const oversized = new CodexLabDynamicToolHost(
      { endpoint: ENDPOINT, credential: CREDENTIAL, expectedReceipt: receipt() },
      async () => ({ ok: true, result: 'x'.repeat(70_000), receipt: receipt() })
    )
    const untrustedRefusal = new CodexLabDynamicToolHost(
      { endpoint: ENDPOINT, credential: CREDENTIAL, expectedReceipt: receipt() },
      async () => ({
        ok: false,
        reason: CREDENTIAL,
        receipt: receipt()
      })
    )

    const tooLarge = await oversized.invoke(invocation())
    const refused = await untrustedRefusal.invoke(invocation({ callId: 'call_757_2' }))

    expect(tooLarge.contentItems[0].text).toContain('result_too_large')
    expect(refused.contentItems[0].text).toContain('gateway_refused')
    expect(JSON.stringify(refused)).not.toContain(CREDENTIAL)
  })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
