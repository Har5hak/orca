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

type CallGateway = typeof callLabDispatchGateway

/** Host-only bridge. The Codex child receives neither the gateway endpoint nor its bearer. */
export class CodexLabDynamicToolHost {
  readonly #endpoint: string
  readonly #credential: string
  readonly #expectedReceipt: LabGatewayServerReceipt
  readonly #callGateway: CallGateway
  readonly #abort = new AbortController()
  readonly #seenCallIds = new Set<string>()
  #disposed = false

  constructor(
    binding: CodexLabDynamicToolGatewayBinding,
    callGateway: CallGateway = callLabDispatchGateway
  ) {
    this.#endpoint = binding.endpoint
    this.#credential = binding.credential
    this.#expectedReceipt = binding.expectedReceipt
    this.#callGateway = callGateway
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
  }
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
