import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { LabUnixSocketLifecycleHooks } from '../../rpc/lab-unix-socket-lifecycle'
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
  sameLabGatewayBinding,
  type LabGatewayWireResponse,
  type LabGatewayWireRefusalReason
} from './dispatch-gateway-wire'
import { LabGatewayServerLifecycle } from './dispatch-gateway-server-lifecycle'
import {
  buildLabGatewayServerReceipt,
  type LabGatewayServerReceipt
} from './dispatch-gateway-server-receipt'

export type { LabGatewayServerReceipt } from './dispatch-gateway-server-receipt'

const DISPATCH_CAPABILITY_PATTERN = /^dcap_[A-Za-z0-9_-]{43}$/u

export type LabGatewayCanonicalLifecycle = Readonly<{
  binding: LabGatewayBinding
  processIncarnation: string
  dispatchCapabilitySha256: string
  authorityState: unknown
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

export type LabDispatchGatewayServerTestHooks = Readonly<{
  socketLifecycle?: LabUnixSocketLifecycleHooks
}>

export class LabDispatchGatewayServer {
  private readonly transport: UnixSocketTransport
  private readonly options: LabDispatchGatewayServerOptions
  private readonly lifecycle = new LabGatewayServerLifecycle<LabGatewayServerReceipt>()
  private policy: LabGatewayPolicy

  constructor(
    options: LabDispatchGatewayServerOptions,
    testHooks: LabDispatchGatewayServerTestHooks = {}
  ) {
    validateServerOptions(options)
    this.policy = Object.freeze({
      ...options.policy,
      binding: Object.freeze({ ...options.policy.binding })
    })
    this.options = Object.freeze({ ...options, policy: this.policy })
    this.transport = UnixSocketTransport.forLaboratoryGateway(
      options.endpoint,
      testHooks.socketLifecycle
    )
    this.transport.onMessage((raw, reply, context) => {
      void this.handleMessage(raw, context)
        .then((response) => reply(JSON.stringify(response)))
        .catch(() => reply(JSON.stringify(this.failure('unknown', 'upstream_failed'))))
    })
  }

  start(): Promise<LabGatewayServerReceipt> {
    return this.lifecycle.start({
      startTransport: async () => {
        if (existsSync(this.options.endpoint)) {
          throw new Error('Laboratory gateway endpoint must not already exist')
        }
        await this.transport.start()
      },
      buildReceipt: async () => {
        const endpointAttestation = await this.transport.attestLaboratoryEndpoint()
        return buildLabGatewayServerReceipt(
          this.options.endpoint,
          this.options.processIncarnation,
          this.policy.policyId,
          this.policy.binding.dispatchId,
          endpointAttestation
        )
      },
      stopTransport: async () => await this.transport.stop()
    })
  }

  stop(): Promise<void> {
    return this.lifecycle.stop(async () => await this.transport.stop())
  }

  private async handleMessage(
    raw: string,
    context?: RpcMessageContext
  ): Promise<LabGatewayWireResponse> {
    const parsed = parseLabGatewayWireRequest(raw, this.policy.binding)
    if (!parsed.ok) {
      this.recordAudit(parsed.id, 'rejected', 'refused', parsed.reason)
      return this.failure(parsed.id, parsed.reason, parsed.field)
    }
    const localRefusal = this.localAuthorityRefusal()
    if (localRefusal) {
      return this.failure(parsed.parsed.id, localRefusal)
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
    const postResolutionLocalRefusal = this.localAuthorityRefusal()
    if (postResolutionLocalRefusal) {
      return this.failure(parsed.parsed.id, postResolutionLocalRefusal)
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
    const signal = context?.signal
      ? AbortSignal.any([context.signal, this.lifecycle.authoritySignal])
      : this.lifecycle.authoritySignal
    try {
      const result = await this.options.invokeRpc({
        rpc: admission.rpc,
        dispatchCapability: this.options.dispatchCapability,
        processIncarnation: this.options.processIncarnation,
        terminalPaneKey: this.policy.binding.terminalPaneKey,
        signal
      })
      if (!this.lifecycle.isAuthorityActive) {
        this.recordAudit(
          parsed.parsed.id,
          parsed.parsed.request.operation,
          'refused',
          'credential_revoked'
        )
        return this.failure(parsed.parsed.id, 'credential_revoked')
      }
      this.recordAudit(parsed.parsed.id, parsed.parsed.request.operation, 'accepted')
      return {
        id: parsed.parsed.id,
        ok: true,
        result: result ?? null,
        receipt: this.requireReceipt()
      }
    } catch {
      const reason = this.lifecycle.isAuthorityActive ? 'upstream_failed' : 'credential_revoked'
      this.recordAudit(parsed.parsed.id, parsed.parsed.request.operation, 'refused', reason)
      return this.failure(parsed.parsed.id, reason)
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
    if (!sameLabGatewayBinding(lifecycle.binding, expected)) {
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
    if (lifecycle.authorityState === 'settled') {
      return 'dispatch_settled'
    }
    return lifecycle.authorityState === 'active' ? null : 'dispatch_invalid'
  }

  private localAuthorityRefusal(): LabGatewayWireRefusalReason | null {
    if (this.lifecycle.authorityState === 'starting') {
      return 'gateway_not_ready'
    }
    return this.lifecycle.authorityState === 'active' ? null : 'credential_revoked'
  }

  private failure(
    id: string,
    reason: LabGatewayWireRefusalReason,
    field?: string
  ): LabGatewayWireResponse {
    return {
      id,
      ok: false,
      error: {
        code: 'lab_gateway_refused',
        message: 'Laboratory gateway request was refused.',
        data: field ? { reason, field } : { reason }
      },
      receipt: this.lifecycle.receipt ?? undefined
    }
  }

  private recordAudit(
    requestId: string,
    operation: string,
    outcome: LabGatewayAuditEvent['outcome'],
    reason?: LabGatewayWireRefusalReason
  ): void {
    const receipt = this.lifecycle.receipt
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
    if (!this.lifecycle.receipt) {
      throw new Error('Laboratory gateway is not started')
    }
    return this.lifecycle.receipt
  }
}

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

function startKeepaliveForBlockingRpc(rpc: LabGatewayRpc, context?: RpcMessageContext): void {
  if (
    rpc.method === 'orchestration.ask' ||
    (rpc.method === 'orchestration.check' && rpc.params.wait === true)
  ) {
    context?.startKeepalive()
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
