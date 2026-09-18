import { createHash } from 'node:crypto'
import {
  LabGatewayClientFailure,
  callLabDispatchGateway,
  type LabGatewayClientResult
} from '../runtime/orchestration/lab-profile/dispatch-gateway-client'
import type { LabGatewayServerReceipt } from '../runtime/orchestration/lab-profile/dispatch-gateway-server'
import { mapCodexLabDynamicToolCall } from './codex-lab-dynamic-tool-contract'

const CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const MAX_CALLS_PER_SESSION = 256
const MAX_TOOL_RESPONSE_BYTES = 64 * 1024

const SAFE_GATEWAY_REFUSALS = new Set([
  'arbitrary_send_forbidden',
  'caller_identity_forbidden',
  'credential_field_forbidden',
  'credential_invalid',
  'credential_revoked',
  'cross_dispatch_identity',
  'dispatch_capability_invalid',
  'dispatch_invalid',
  'dispatch_settled',
  'invalid_parameters',
  'invalid_request',
  'lifecycle_binding_mismatch',
  'lifecycle_creation_forbidden',
  'lifecycle_mutation_forbidden',
  'lifecycle_unavailable',
  'policy_terminal',
  'process_incarnation_mismatch',
  'raw_method_forbidden',
  'raw_terminal_forbidden',
  'unknown_operation',
  'upstream_failed',
  'worker_done_already_accepted'
])

export type CodexLabDynamicToolResponse = Readonly<{
  contentItems: readonly [Readonly<{ type: 'inputText'; text: string }>]
  success: boolean
}>

export type CodexLabDynamicToolInvocation = Readonly<{
  callId: unknown
  namespace: unknown
  tool: unknown
  arguments: unknown
}>

export type CodexLabDynamicToolGatewayBinding = Readonly<{
  endpoint: string
  credential: string
  expectedReceipt: LabGatewayServerReceipt
}>

export type CodexLabDynamicToolHostPort = Readonly<{
  invoke: (invocation: CodexLabDynamicToolInvocation) => Promise<CodexLabDynamicToolResponse>
  dispose: () => void
}>

export type CodexLabDynamicToolHostFactory = () => CodexLabDynamicToolHostPort

export type CodexLabDynamicToolHostAttestation = Readonly<{
  dispatchId: string
  endpointSha256: string
  gatewayAccessSha256: string
}>

const attestationsByHost = new WeakMap<object, CodexLabDynamicToolHostAttestation>()
const revokedFactories = new WeakSet<object>()
const factoryStates = new WeakMap<
  object,
  {
    status: 'fresh' | 'claimed'
    binding: CodexLabDynamicToolGatewayBinding
    attestation: CodexLabDynamicToolHostAttestation
  }
>()

type CallGateway = typeof callLabDispatchGateway

/** Host-only bridge. The Codex child receives neither the gateway endpoint nor its bearer. */
export class CodexLabDynamicToolHost {
  readonly #endpoint: string
  #credential: string
  readonly #expectedReceipt: LabGatewayServerReceipt
  readonly #callGateway: CallGateway
  readonly #abort = new AbortController()
  readonly #seenCallIds = new Set<string>()
  #disposed = false

  constructor(
    binding: CodexLabDynamicToolGatewayBinding,
    callGateway: CallGateway = callLabDispatchGateway
  ) {
    const attestation = attestGatewayBinding(binding)
    this.#endpoint = binding.endpoint
    this.#credential = binding.credential
    this.#expectedReceipt = binding.expectedReceipt
    this.#callGateway = callGateway
    attestationsByHost.set(this, attestation)
    Object.freeze(this)
  }

  async invoke(invocation: CodexLabDynamicToolInvocation): Promise<CodexLabDynamicToolResponse> {
    if (this.#disposed) {
      return response(false, { ok: false, reason: 'host_disposed' })
    }
    if (!isCodexLabDynamicToolCallId(invocation.callId)) {
      return response(false, { ok: false, reason: 'call_id_invalid' })
    }
    if (this.#seenCallIds.has(invocation.callId)) {
      return response(false, { ok: false, reason: 'call_replayed' })
    }
    if (this.#seenCallIds.size >= MAX_CALLS_PER_SESSION) {
      return response(false, { ok: false, reason: 'call_budget_exhausted' })
    }
    this.#seenCallIds.add(invocation.callId)

    const mapped = mapCodexLabDynamicToolCall(
      invocation.namespace,
      invocation.tool,
      invocation.arguments
    )
    if (!mapped.ok) {
      return response(false, { ok: false, reason: mapped.reason, field: mapped.field })
    }

    let result: LabGatewayClientResult
    try {
      result = await this.#callGateway({
        endpoint: this.#endpoint,
        credential: this.#credential,
        expectedReceipt: this.#expectedReceipt,
        operation: mapped.operation,
        params: mapped.params,
        signal: this.#abort.signal
      })
    } catch (error) {
      return response(false, {
        ok: false,
        reason:
          error instanceof LabGatewayClientFailure ? error.reason : 'gateway_invocation_failed'
      })
    }
    if (!result.ok) {
      return response(false, {
        ok: false,
        reason: SAFE_GATEWAY_REFUSALS.has(result.reason) ? result.reason : 'gateway_refused'
      })
    }
    return response(true, { ok: true, result: result.result })
  }

  dispose(): void {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    this.#abort.abort()
    this.#seenCallIds.clear()
    this.#credential = ''
  }
}

/** Captures immutable gateway authority and mints one independently disposable port per acquire. */
export function createCodexLabDynamicToolHostFactory(
  candidate: CodexLabDynamicToolGatewayBinding
): CodexLabDynamicToolHostFactory {
  const binding = snapshotGatewayBinding(candidate)
  const attestation = attestGatewayBinding(binding)
  const factory = allocateSecretFreeDynamicToolHostFactory()
  factoryStates.set(factory, { status: 'fresh', binding, attestation })
  return factory
}

/** Transfers one fresh factory into exactly one in-memory launch binding. */
export function claimCodexLabDynamicToolHostFactory(
  factory: CodexLabDynamicToolHostFactory
): boolean {
  const state = factoryStates.get(factory)
  if (state?.status !== 'fresh') {
    return false
  }
  state.status = 'claimed'
  return true
}

/** Revokes only future mints; already-published ports retain independent acquisition custody. */
export function revokeCodexLabDynamicToolHostFactory(
  factory: CodexLabDynamicToolHostFactory
): void {
  if (factoryStates.delete(factory)) {
    revokedFactories.add(factory)
  }
}

export function isCodexLabDynamicToolHostFactoryBoundTo(
  factory: unknown,
  expected: CodexLabDynamicToolHostAttestation
): factory is CodexLabDynamicToolHostFactory {
  if (typeof factory !== 'function' || !Object.isFrozen(factory)) {
    return false
  }
  const state = factoryStates.get(factory)
  return sameAttestation(state?.attestation, expected)
}

/** Confirms that an opaque host port was minted for this exact sealed laboratory binding. */
export function isCodexLabDynamicToolHostBoundTo(
  host: unknown,
  expected: CodexLabDynamicToolHostAttestation
): boolean {
  if (typeof host !== 'object' || host === null || !Object.isFrozen(host)) {
    return false
  }
  return sameAttestation(attestationsByHost.get(host), expected)
}

export function isCodexLabDynamicToolCallId(value: unknown): value is string {
  return typeof value === 'string' && CALL_ID_PATTERN.test(value)
}

function response(
  success: boolean,
  payload: Readonly<Record<string, unknown>>
): CodexLabDynamicToolResponse {
  let text: string
  try {
    text = JSON.stringify(payload)
  } catch {
    return fixedFailure('result_not_serializable')
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_RESPONSE_BYTES) {
    return fixedFailure('result_too_large')
  }
  return Object.freeze({
    contentItems: Object.freeze([Object.freeze({ type: 'inputText' as const, text })] as const),
    success
  })
}

function fixedFailure(reason: string): CodexLabDynamicToolResponse {
  return Object.freeze({
    contentItems: Object.freeze([
      Object.freeze({ type: 'inputText' as const, text: JSON.stringify({ ok: false, reason }) })
    ] as const),
    success: false
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function attestGatewayBinding(
  binding: CodexLabDynamicToolGatewayBinding
): CodexLabDynamicToolHostAttestation {
  const endpointSha256 = sha256(binding.endpoint)
  if (
    binding.expectedReceipt.endpointSha256 !== endpointSha256 ||
    !Object.isFrozen(binding.expectedReceipt) ||
    !Object.isFrozen(binding.expectedReceipt.endpointIdentity) ||
    !Object.isFrozen(binding.expectedReceipt.allowedOperations)
  ) {
    throw new Error(
      'Codex laboratory dynamic-tool host binding is not immutable and self-consistent'
    )
  }
  return Object.freeze({
    dispatchId: binding.expectedReceipt.dispatchId,
    endpointSha256,
    gatewayAccessSha256: sha256(binding.credential)
  })
}

function snapshotGatewayBinding(
  candidate: CodexLabDynamicToolGatewayBinding
): CodexLabDynamicToolGatewayBinding {
  return Object.freeze({
    endpoint: candidate.endpoint,
    credential: candidate.credential,
    expectedReceipt: candidate.expectedReceipt
  })
}

function sameAttestation(
  actual: CodexLabDynamicToolHostAttestation | undefined,
  expected: CodexLabDynamicToolHostAttestation
): boolean {
  return (
    actual?.dispatchId === expected.dispatchId &&
    actual.endpointSha256 === expected.endpointSha256 &&
    actual.gatewayAccessSha256 === expected.gatewayAccessSha256
  )
}

function allocateSecretFreeDynamicToolHostFactory(): CodexLabDynamicToolHostFactory {
  // This no-argument activation keeps gateway binding material out of the callable's closure.
  const factory = (): CodexLabDynamicToolHostPort => mintCodexLabDynamicToolHost(factory)
  return Object.freeze(factory)
}

function mintCodexLabDynamicToolHost(
  factory: CodexLabDynamicToolHostFactory
): CodexLabDynamicToolHostPort {
  const state = factoryStates.get(factory)
  if (state?.status !== 'claimed') {
    const status = revokedFactories.has(factory) ? 'revoked' : (state?.status ?? 'invalid')
    throw new Error(`Codex laboratory dynamic-tool host factory is ${status}`)
  }
  return new CodexLabDynamicToolHost(state.binding)
}
