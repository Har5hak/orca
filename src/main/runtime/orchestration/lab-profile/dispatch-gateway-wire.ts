import type {
  LabGatewayBinding,
  LabGatewayRefusalReason,
  LabGatewayRequest
} from './dispatch-gateway-policy'
import { findCallerIdentityRefusal } from './dispatch-gateway-request-validation'

const REQUEST_FIELDS = new Set(['id', 'credential', 'operation', 'params'])
const SERVER_CREDENTIAL_FIELDS = new Set([
  'authToken',
  'runtimeToken',
  'sharedToken',
  'dispatchCapability',
  'orchestrationCapability'
])
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export type LabGatewayWireRefusalReason =
  | LabGatewayRefusalReason
  | 'credential_field_forbidden'
  | 'dispatch_capability_invalid'
  | 'dispatch_invalid'
  | 'dispatch_settled'
  | 'invalid_request'
  | 'lifecycle_binding_mismatch'
  | 'lifecycle_unavailable'
  | 'process_incarnation_mismatch'
  | 'raw_method_forbidden'
  | 'upstream_failed'

export type ParsedLabGatewayWireRequest = Readonly<{
  id: string
  request: LabGatewayRequest
  envelopeRefusal?: Readonly<{
    reason: LabGatewayWireRefusalReason
    field?: string
  }>
}>

export type LabGatewayWireParseResult =
  | Readonly<{ ok: true; parsed: ParsedLabGatewayWireRequest }>
  | Readonly<{
      ok: false
      id: string
      reason: LabGatewayWireRefusalReason
      field?: string
    }>

export function parseLabGatewayWireRequest(
  raw: string,
  binding: LabGatewayBinding
): LabGatewayWireParseResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, id: 'unknown', reason: 'invalid_request' }
  }
  if (!isRecord(value)) {
    return { ok: false, id: 'unknown', reason: 'invalid_request' }
  }
  const id = typeof value.id === 'string' && REQUEST_ID_PATTERN.test(value.id) ? value.id : null
  if (id === null || typeof value.credential !== 'string' || typeof value.operation !== 'string') {
    return { ok: false, id: id ?? 'unknown', reason: 'invalid_request' }
  }
  const request: LabGatewayRequest = {
    credential: value.credential,
    operation: value.operation,
    ...('params' in value ? { params: value.params } : {})
  }
  const envelopeRefusal = findEnvelopeRefusal(value, binding)
  return {
    ok: true,
    parsed: envelopeRefusal ? { id, request, envelopeRefusal } : { id, request }
  }
}

function findEnvelopeRefusal(
  value: Readonly<Record<string, unknown>>,
  binding: LabGatewayBinding
): ParsedLabGatewayWireRequest['envelopeRefusal'] {
  if ('method' in value) {
    return { reason: 'raw_method_forbidden', field: 'method' }
  }
  for (const field of SERVER_CREDENTIAL_FIELDS) {
    if (field in value) {
      return { reason: 'credential_field_forbidden', field }
    }
  }
  const identityRefusal = findCallerIdentityRefusal(value, binding)
  if (identityRefusal) {
    return identityRefusal
  }
  const unknownField = Object.keys(value).find((field) => !REQUEST_FIELDS.has(field))
  return unknownField ? { reason: 'invalid_request', field: unknownField } : undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
