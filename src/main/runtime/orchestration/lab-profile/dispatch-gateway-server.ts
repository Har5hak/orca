import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { RpcMessageContext } from '../../rpc/transport'
import { UnixSocketTransport } from '../../rpc/unix-socket-transport'
import {
  LAB_GATEWAY_ALLOWED_OPERATIONS,
  admitLabGatewayRequest,
  type LabGatewayBinding,
  type LabGatewayOperation,
  type LabGatewayPolicy,
  type LabGatewayRpc
} from './dispatch-gateway-policy'
import {
  parseLabGatewayWireRequest,
  type LabGatewayWireRefusalReason
} from './dispatch-gateway-wire'

const DISPATCH_CAPABILITY_PATTERN = /^dcap_[A-Za-z0-9_-]{43}$/u

export type LabGatewayCanonicalLifecycle = Readonly<{
  binding: LabGatewayBinding
  processIncarnation: string
  dispatchCapabilitySha256: string
  authorityState: 'active' | 'invalid' | 'revoked' | 'settled'
}>

export type LabGatewayServerReceipt = Readonly<{
  schema: 'orca.lab-dispatch-gateway.v1'
  policyId: string
  dispatchId: string
  transport: 'unix'
  socketMode: '0600'
  endpointSha256: string
  processIncarnationSha256: string
  allowedOperations: readonly LabGatewayOperation[]
  lifecycleSource: 'injected-per-request'
  dcapCustody: 'server-only'
  receiptSha256: string
}>

export type LabGatewayAuditEvent = Readonly<{
  schema: 'orca.lab-dispatch-gateway-audit.v1'
  policyId: string
  dispatchId: string
  requestIdSha256: string
  operation: LabGatewayOperation | 'rejected'
  outcome: 'accepted' | 'refused'
  reason?: LabGatewayWireRefusalReason
  receiptSha256: string
}>

export type LabGatewayRpcInvocation = Readonly<{
  rpc: LabGatewayRpc
  dispatchCapability: string
  processIncarnation: string
  terminalPaneKey: string
  signal: AbortSignal
}>

export type LabDispatchGatewayServerOptions = Readonly<{
  endpoint: string
  policy: LabGatewayPolicy
  processIncarnation: string
  dispatchCapability: string
  resolveLifecycle: (dispatchId: string) => Promise<LabGatewayCanonicalLifecycle | null>
  invokeRpc: (invocation: LabGatewayRpcInvocation) => Promise<unknown>
  audit?: (event: LabGatewayAuditEvent) => void
}>

export class LabDispatchGatewayServer {
  private readonly transport: UnixSocketTransport
  private readonly options: LabDispatchGatewayServerOptions
  private policy: LabGatewayPolicy
  private receipt: LabGatewayServerReceipt | null = null

  constructor(options: LabDispatchGatewayServerOptions) {
    validateServerOptions(options)
    this.policy = Object.freeze({
      ...options.policy,
      binding: Object.freeze({ ...options.policy.binding })
    })
    this.options = Object.freeze({ ...options, policy: this.policy })
    this.transport = new UnixSocketTransport({ endpoint: options.endpoint, kind: 'unix' })
    this.transport.onMessage((raw, reply, context) => {
      void this.handleMessage(raw, context)
        .then((response) => reply(JSON.stringify(response)))
        .catch(() => reply(JSON.stringify(this.failure('unknown', 'upstream_failed'))))
    })
  }

  async start(): Promise<LabGatewayServerReceipt> {
    if (this.receipt) {
      return this.receipt
    }
    if (existsSync(this.options.endpoint)) {
      throw new Error('Laboratory gateway endpoint must not already exist')
    }
    await this.transport.start()
    try {
      const mode = (await stat(this.options.endpoint)).mode & 0o777
      if (mode !== 0o600) {
        throw new Error('Laboratory gateway socket mode is not 0600')
      }
      this.receipt = buildServerReceipt(this.options, this.policy)
      return this.receipt
    } catch (error) {
      await this.transport.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.receipt = null
    await this.transport.stop()
  }

  private async handleMessage(raw: string, context?: RpcMessageContext): Promise<WireResponse> {
    const parsed = parseLabGatewayWireRequest(raw, this.policy.binding)
    if (!parsed.ok) {
      this.recordAudit(parsed.id, 'rejected', 'refused', parsed.reason)
      return this.failure(parsed.id, parsed.reason, parsed.field)
    }

    let admission = admitLabGatewayRequest(this.policy, parsed.parsed.request)
    if (!admission.ok) {
      this.recordAudit(parsed.parsed.id, 'rejected', 'refused', admission.refusal.reason)
      return this.failure(parsed.parsed.id, admission.refusal.reason, admission.refusal.field)
    }
    if (parsed.parsed.envelopeRefusal) {
      const { reason, field } = parsed.parsed.envelopeRefusal
      this.recordAudit(parsed.parsed.id, 'rejected', 'refused', reason)
      return this.failure(parsed.parsed.id, reason, field)
    }

    const lifecycleRefusal = await this.resolveLifecycleRefusal()
    if (lifecycleRefusal) {
      this.recordAudit(
        parsed.parsed.id,
        parsed.parsed.request.operation,
        'refused',
        lifecycleRefusal
      )
      return this.failure(parsed.parsed.id, lifecycleRefusal)
    }

    // A blocking lifecycle lookup lets another request advance the one-shot policy. Re-admit
    // against the current state, then consume worker.done before invoking upstream.
    admission = admitLabGatewayRequest(this.policy, parsed.parsed.request)
    if (!admission.ok) {
      this.recordAudit(parsed.parsed.id, 'rejected', 'refused', admission.refusal.reason)
      return this.failure(parsed.parsed.id, admission.refusal.reason, admission.refusal.field)
    }
    this.policy = admission.nextPolicy

    startKeepaliveForBlockingRpc(admission.rpc, context)
    const signal = context?.signal ?? new AbortController().signal
    try {
      const result = await this.options.invokeRpc({
        rpc: admission.rpc,
        dispatchCapability: this.options.dispatchCapability,
        processIncarnation: this.options.processIncarnation,
        terminalPaneKey: this.policy.binding.terminalPaneKey,
        signal
      })
      this.recordAudit(parsed.parsed.id, parsed.parsed.request.operation, 'accepted')
      return {
        id: parsed.parsed.id,
        ok: true,
        result: result ?? null,
        receipt: this.requireReceipt()
      }
    } catch {
      this.recordAudit(
        parsed.parsed.id,
        parsed.parsed.request.operation,
        'refused',
        'upstream_failed'
      )
      return this.failure(parsed.parsed.id, 'upstream_failed')
    }
  }

  private async resolveLifecycleRefusal(): Promise<LabGatewayWireRefusalReason | null> {
    let lifecycle: LabGatewayCanonicalLifecycle | null
    try {
      lifecycle = await this.options.resolveLifecycle(this.policy.binding.dispatchId)
    } catch {
      return 'lifecycle_unavailable'
    }
    if (!lifecycle || lifecycle.authorityState === 'invalid') {
      return 'dispatch_invalid'
    }
    const expected = this.policy.binding
    if (lifecycle.binding.dispatchId !== expected.dispatchId) {
      return 'cross_dispatch_identity'
    }
    if (!sameBinding(lifecycle.binding, expected)) {
      return 'lifecycle_binding_mismatch'
    }
    if (lifecycle.dispatchCapabilitySha256 !== sha256(this.options.dispatchCapability)) {
      return 'dispatch_capability_invalid'
    }
    if (lifecycle.processIncarnation !== this.options.processIncarnation) {
      return 'process_incarnation_mismatch'
    }
    if (lifecycle.authorityState === 'revoked') {
      return 'credential_revoked'
    }
    return lifecycle.authorityState === 'settled' ? 'dispatch_settled' : null
  }

  private failure(id: string, reason: LabGatewayWireRefusalReason, field?: string): WireResponse {
    return {
      id,
      ok: false,
      error: {
        code: 'lab_gateway_refused',
        message: 'Laboratory gateway request was refused.',
        data: field ? { reason, field } : { reason }
      },
      receipt: this.receipt ?? undefined
    }
  }

  private recordAudit(
    requestId: string,
    operation: string,
    outcome: LabGatewayAuditEvent['outcome'],
    reason?: LabGatewayWireRefusalReason
  ): void {
    const receipt = this.receipt
    if (!receipt || !this.options.audit) {
      return
    }
    const allowedOperation = LAB_GATEWAY_ALLOWED_OPERATIONS.find((entry) => entry === operation)
    const event: LabGatewayAuditEvent = Object.freeze({
      schema: 'orca.lab-dispatch-gateway-audit.v1',
      policyId: this.policy.policyId,
      dispatchId: this.policy.binding.dispatchId,
      requestIdSha256: sha256(requestId),
      operation: allowedOperation ?? 'rejected',
      outcome,
      ...(reason === undefined ? {} : { reason }),
      receiptSha256: receipt.receiptSha256
    })
    try {
      this.options.audit(event)
    } catch {
      // Audit observation must not change gateway authority decisions.
    }
  }

  private requireReceipt(): LabGatewayServerReceipt {
    if (!this.receipt) {
      throw new Error('Laboratory gateway is not started')
    }
    return this.receipt
  }
}

type WireResponse = Readonly<{
  id: string
  ok: boolean
  result?: unknown
  error?: Readonly<{
    code: 'lab_gateway_refused'
    message: string
    data: Readonly<{ reason: LabGatewayWireRefusalReason; field?: string }>
  }>
  receipt?: LabGatewayServerReceipt
}>

function validateServerOptions(options: LabDispatchGatewayServerOptions): void {
  if (!isAbsolute(options.endpoint) || options.endpoint.includes('\u0000')) {
    throw new Error('Laboratory gateway endpoint must be an absolute path')
  }
  if (options.policy.revoked || options.policy.terminal || options.policy.workerDoneAccepted) {
    throw new Error('Laboratory gateway policy must be a fresh immutable admission policy')
  }
  if (!options.processIncarnation.trim()) {
    throw new Error('Laboratory gateway process incarnation must be non-empty')
  }
  if (!DISPATCH_CAPABILITY_PATTERN.test(options.dispatchCapability)) {
    throw new Error('Laboratory gateway Dispatch capability is invalid')
  }
}

function buildServerReceipt(
  options: LabDispatchGatewayServerOptions,
  policy: LabGatewayPolicy
): LabGatewayServerReceipt {
  const stable = Object.freeze({
    schema: 'orca.lab-dispatch-gateway.v1' as const,
    policyId: policy.policyId,
    dispatchId: policy.binding.dispatchId,
    transport: 'unix' as const,
    socketMode: '0600' as const,
    endpointSha256: sha256(options.endpoint),
    processIncarnationSha256: sha256(options.processIncarnation),
    allowedOperations: Object.freeze([...LAB_GATEWAY_ALLOWED_OPERATIONS]),
    lifecycleSource: 'injected-per-request' as const,
    dcapCustody: 'server-only' as const
  })
  return Object.freeze({ ...stable, receiptSha256: sha256(JSON.stringify(stable)) })
}

function sameBinding(left: LabGatewayBinding, right: LabGatewayBinding): boolean {
  return (
    left.runId === right.runId &&
    left.taskId === right.taskId &&
    left.dispatchId === right.dispatchId &&
    left.terminalHandle === right.terminalHandle &&
    left.terminalPaneKey === right.terminalPaneKey
  )
}

function startKeepaliveForBlockingRpc(rpc: LabGatewayRpc, context?: RpcMessageContext): void {
  if (
    rpc.method === 'orchestration.ask' ||
    (rpc.method === 'orchestration.check' && rpc.params.wait === true)
  ) {
    context?.startKeepalive()
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
