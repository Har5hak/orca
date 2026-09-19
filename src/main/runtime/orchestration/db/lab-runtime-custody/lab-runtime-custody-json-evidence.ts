import { join } from 'node:path'
import {
  LAB_GATEWAY_ALLOWED_OPERATIONS,
  LAB_GATEWAY_UNWIRED_BOUNDARIES
} from '../../lab-profile/dispatch-gateway-policy-contract'
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
import {
  rejectSuspiciousJsonEvidence,
  requireExactDataObject,
  requireSafeCustodyLabel,
  sameStrings,
  snapshotExactArray
} from './lab-runtime-custody-json-validation'

export { rejectSuspiciousJsonEvidence } from './lab-runtime-custody-json-validation'

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
    'policyReceipt',
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
  const policyReceipt = normalizeGatewayPolicyReceipt(
    receipt.policyReceipt,
    dispatchId,
    receipt.policyId
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
    policyReceipt,
    allowedOperations: LAB_GATEWAY_ALLOWED_OPERATIONS,
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
    policyReceipt: receipt.policyReceipt,
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

function normalizeGatewayPolicyReceipt(
  value: unknown,
  dispatchId: string,
  gatewayPolicyId: unknown
): CodexLabGatewayPublicReceipt['policyReceipt'] {
  const receipt = requireExactDataObject(value, 'gateway policy receipt', [
    'schema',
    'policyId',
    'binding',
    'allowedOperations',
    'state',
    'workerDoneAccepted',
    'unwiredBoundaries',
    'sourcePolicyDigest',
    'receiptSha256'
  ])
  const binding = requireExactDataObject(receipt.binding, 'gateway lifecycle binding', [
    'runIdSha256',
    'taskIdSha256',
    'dispatchIdSha256',
    'terminalHandleSha256',
    'terminalPaneKeySha256'
  ])
  const normalizedBinding = Object.freeze({
    runIdSha256: requireSha256Value(binding.runIdSha256, 'Run id digest'),
    taskIdSha256: requireSha256Value(binding.taskIdSha256, 'Task id digest'),
    dispatchIdSha256: requireSha256Value(binding.dispatchIdSha256, 'Dispatch id digest'),
    terminalHandleSha256: requireSha256Value(
      binding.terminalHandleSha256,
      'terminal handle digest'
    ),
    terminalPaneKeySha256: requireSha256Value(
      binding.terminalPaneKeySha256,
      'terminal pane key digest'
    )
  })
  const allowedOperations = snapshotExactArray(
    receipt.allowedOperations,
    'gateway policy operations'
  )
  const unwiredBoundaries = snapshotExactArray(
    receipt.unwiredBoundaries,
    'gateway policy unwired boundaries'
  )
  const policyId = requireSafeCustodyLabel(
    requireStringValue(receipt.policyId, 'gateway policy id'),
    'gateway policy id'
  )
  const sourcePolicyDigest = requireSha256Value(
    receipt.sourcePolicyDigest,
    'gateway source policy digest'
  )
  const receiptSha256 = requireSha256Value(
    receipt.receiptSha256,
    'gateway public policy receipt digest'
  )
  const stable = Object.freeze({
    schema: 'orca.lab-gateway-policy-public.v1' as const,
    policyId,
    binding: normalizedBinding,
    allowedOperations: LAB_GATEWAY_ALLOWED_OPERATIONS,
    state: 'active' as const,
    workerDoneAccepted: false,
    unwiredBoundaries: LAB_GATEWAY_UNWIRED_BOUNDARIES,
    sourcePolicyDigest
  })
  if (
    receipt.schema !== 'orca.lab-gateway-policy-public.v1' ||
    policyId !== gatewayPolicyId ||
    normalizedBinding.dispatchIdSha256 !== sha256(dispatchId) ||
    !sameStrings(allowedOperations, LAB_GATEWAY_ALLOWED_OPERATIONS) ||
    receipt.state !== 'active' ||
    receipt.workerDoneAccepted !== false ||
    !sameStrings(unwiredBoundaries, LAB_GATEWAY_UNWIRED_BOUNDARIES) ||
    receiptSha256 !== sha256(JSON.stringify(stable))
  ) {
    throw new Error('Codex laboratory runtime gateway policy receipt is invalid.')
  }
  return Object.freeze({ ...stable, receiptSha256 })
}
