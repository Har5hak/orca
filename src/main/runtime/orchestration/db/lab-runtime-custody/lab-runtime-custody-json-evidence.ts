import { join } from 'node:path'
import { LAB_GATEWAY_ALLOWED_OPERATIONS } from '../../lab-profile/dispatch-gateway-policy-contract'
import type {
  CodexLabGatewayPublicReceipt,
  CodexLabRuntimeGatewayEvidence
} from './lab-runtime-custody-contract'
import {
  expectedCodexLabDispatchRuntimeRoot,
  requireCodexLabCustodyIdentityParts,
  requireDecimalIdentity,
  requireLiteral,
  requireSha256Value,
  requireStringValue,
  sha256
} from './lab-runtime-custody-validation'

const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u
const SUSPICIOUS_JSON_KEY =
  /(?:authorization|bearer|credential|dcap|password|secret|token|api.?key)/iu
const SUSPICIOUS_JSON_VALUE =
  /(?:\bbearer\s+|\blgw1_|\bdcap_|\bsk-[A-Za-z0-9]|access[_-]?token|refresh[_-]?token|private[_-]?key)/iu

export function rejectSuspiciousJsonEvidence(value: unknown): void {
  visitJsonEvidence(value, new Set<object>())
}

export function normalizeCodexLabGatewayEvidence(input: unknown): CodexLabRuntimeGatewayEvidence {
  const object = requireExactDataObject(input, 'gateway evidence', [
    'dispatchId',
    'profileId',
    'receipt'
  ])
  const dispatchId = requireStringValue(object.dispatchId, 'Dispatch id')
  const profileId = requireStringValue(object.profileId, 'profile id')
  requireCodexLabCustodyIdentityParts(dispatchId, profileId)
  return Object.freeze({
    dispatchId,
    profileId,
    receipt: normalizeCodexLabGatewayPublicReceipt(object.receipt, dispatchId)
  })
}

export function normalizeCodexLabGatewayPublicReceipt(
  value: unknown,
  dispatchId: string
): CodexLabGatewayPublicReceipt {
  const receipt = requireExactDataObject(value, 'gateway receipt', [
    'schema',
    'policyId',
    'dispatchId',
    'transport',
    'socketMode',
    'endpointSha256',
    'endpointIdentity',
    'endpointIdentitySha256',
    'processIncarnationSha256',
    'allowedOperations',
    'lifecycleSource',
    'receiptSha256'
  ])
  if (
    receipt.schema !== 'orca.lab-dispatch-gateway.v1' ||
    receipt.dispatchId !== dispatchId ||
    receipt.transport !== 'unix' ||
    receipt.socketMode !== '0600' ||
    receipt.lifecycleSource !== 'injected-per-request'
  ) {
    throw new Error('Codex laboratory runtime gateway receipt does not match its Dispatch.')
  }
  const endpoint = requireExactDataObject(receipt.endpointIdentity, 'gateway endpoint identity', [
    'device',
    'inode',
    'uid',
    'mode',
    'type'
  ])
  const allowedOperations = snapshotExactArray(
    receipt.allowedOperations,
    'gateway allowed operations'
  )
  if (!sameStrings(allowedOperations, LAB_GATEWAY_ALLOWED_OPERATIONS)) {
    throw new Error('Codex laboratory runtime gateway operations are invalid.')
  }
  const normalized = Object.freeze({
    schema: 'orca.lab-dispatch-gateway.v1' as const,
    policyId: requireSafeCustodyLabel(
      requireStringValue(receipt.policyId, 'gateway policy id'),
      'gateway policy id'
    ),
    dispatchId,
    transport: 'unix' as const,
    socketMode: '0600' as const,
    endpointSha256: requireSha256Value(receipt.endpointSha256, 'gateway endpoint digest'),
    endpointIdentity: Object.freeze({
      device: requireDecimalIdentity(endpoint.device, 'gateway endpoint device'),
      inode: requireDecimalIdentity(endpoint.inode, 'gateway endpoint inode'),
      uid: requireDecimalIdentity(endpoint.uid, 'gateway endpoint uid'),
      mode: requireLiteral(endpoint.mode, '0600', 'gateway endpoint mode'),
      type: requireLiteral(endpoint.type, 'socket', 'gateway endpoint type')
    }),
    endpointIdentitySha256: requireSha256Value(
      receipt.endpointIdentitySha256,
      'gateway endpoint identity digest'
    ),
    processIncarnationSha256: requireSha256Value(
      receipt.processIncarnationSha256,
      'gateway process incarnation digest'
    ),
    allowedOperations: Object.freeze([...LAB_GATEWAY_ALLOWED_OPERATIONS]),
    lifecycleSource: 'injected-per-request' as const,
    receiptSha256: requireSha256Value(receipt.receiptSha256, 'gateway receipt digest')
  })
  requireGatewayReceiptDigests(normalized)
  rejectSuspiciousJsonEvidence(normalized)
  return normalized
}

function requireGatewayReceiptDigests(receipt: CodexLabGatewayPublicReceipt): void {
  const endpoint = join(expectedCodexLabDispatchRuntimeRoot(receipt.dispatchId), 'gateway.sock')
  const stable = {
    schema: receipt.schema,
    policyId: receipt.policyId,
    dispatchId: receipt.dispatchId,
    transport: receipt.transport,
    socketMode: receipt.socketMode,
    endpointSha256: receipt.endpointSha256,
    endpointIdentity: receipt.endpointIdentity,
    endpointIdentitySha256: receipt.endpointIdentitySha256,
    processIncarnationSha256: receipt.processIncarnationSha256,
    allowedOperations: receipt.allowedOperations,
    lifecycleSource: receipt.lifecycleSource,
    dcapCustody: 'server-only'
  }
  if (
    receipt.endpointSha256 !== sha256(endpoint) ||
    receipt.endpointIdentitySha256 !== sha256(JSON.stringify(receipt.endpointIdentity)) ||
    receipt.receiptSha256 !== sha256(JSON.stringify(stable))
  ) {
    throw new Error('Codex laboratory runtime gateway receipt digest is invalid.')
  }
}

function visitJsonEvidence(value: unknown, seen: Set<object>): void {
  if (typeof value === 'string') {
    if (SUSPICIOUS_JSON_VALUE.test(value)) {
      throw new Error('Codex laboratory runtime custody rejected secret-like JSON evidence.')
    }
    return
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw new Error('Codex laboratory runtime custody JSON evidence is not serializable.')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    visitJsonArray(value, seen)
    seen.delete(value)
    return
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || SUSPICIOUS_JSON_KEY.test(key)) {
      throw new Error('Codex laboratory runtime custody rejected a suspicious JSON evidence key.')
    }
    visitJsonEvidence(requireDataField(value, key, 'JSON evidence'), seen)
  }
  seen.delete(value)
}

function requireExactDataObject(
  value: unknown,
  field: string,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} must be an object.`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new Error(`Codex laboratory runtime custody ${field} fields are invalid.`)
  }
  const snapshot: Record<string, unknown> = {}
  for (const key of expectedKeys) {
    snapshot[key] = requireDataField(value, key, field)
  }
  return Object.freeze(snapshot)
}

function snapshotExactArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} must be an array.`)
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value)
  ) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  const expectedKeys = Array.from({ length: lengthDescriptor.value }, (_, index) => String(index))
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length + 1 ||
    keys.some((key) => typeof key !== 'string') ||
    !expectedKeys.every((key) => keys.includes(key)) ||
    !keys.includes('length')
  ) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  return Object.freeze(expectedKeys.map((key) => requireDataField(value, key, field)))
}

function visitJsonArray(value: readonly unknown[], seen: Set<object>): void {
  const keys = Reflect.ownKeys(value)
  const expectedKeys = [...value.keys()].map(String)
  if (
    keys.length !== expectedKeys.length + 1 ||
    keys.at(-1) !== 'length' ||
    keys.slice(0, -1).some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error('Codex laboratory runtime custody JSON evidence array is invalid.')
  }
  for (const key of expectedKeys) {
    visitJsonEvidence(requireDataField(value, key, 'JSON array'), seen)
  }
}

function requireDataField(value: object, key: string, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new Error(`Codex laboratory runtime custody ${field} must use data fields.`)
  }
  return descriptor.value
}

function sameStrings(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function requireSafeCustodyLabel(value: string, field: string): string {
  if (!SAFE_LABEL_PATTERN.test(value) || SUSPICIOUS_JSON_VALUE.test(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  return value
}
