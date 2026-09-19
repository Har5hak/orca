import { join } from 'node:path'
import { CODEX_LAB_RUNTIME_ROOT } from './codex-lab-launch-contract'
import {
  LAB_GATEWAY_ALLOWED_OPERATIONS,
  LAB_GATEWAY_UNWIRED_BOUNDARIES
} from './dispatch-gateway-policy-contract'
import {
  isDecimalIdentity,
  isSafeLabel,
  isSha256,
  requireExactArray,
  requireExactObject,
  sameStrings,
  sha256
} from './codex-lab-launch-receipt-validation-support'

export function validateGatewayReceipt(
  value: unknown,
  dispatchId: string
): Readonly<Record<string, unknown>> {
  const gateway = requireExactObject(value, 'gateway receipt', [
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
  const endpointIdentity = requireExactObject(
    gateway.endpointIdentity,
    'gateway endpoint identity',
    ['device', 'inode', 'uid', 'mode', 'type']
  )
  const allowedOperations = requireExactArray(gateway.allowedOperations, 'gateway operations')
  const policyReceipt = validateGatewayPolicyReceipt(
    gateway.policyReceipt,
    dispatchId,
    gateway.policyId
  )
  const stableGateway = {
    schema: gateway.schema,
    policyId: gateway.policyId,
    dispatchId: gateway.dispatchId,
    transport: gateway.transport,
    socketMode: gateway.socketMode,
    endpointSha256: gateway.endpointSha256,
    endpointIdentity,
    endpointIdentitySha256: gateway.endpointIdentitySha256,
    processIncarnationSha256: gateway.processIncarnationSha256,
    policyReceipt,
    allowedOperations,
    lifecycleSource: gateway.lifecycleSource,
    dcapCustody: 'server-only'
  }
  if (
    gateway.schema !== 'orca.lab-dispatch-gateway.v1' ||
    !isSafeLabel(gateway.policyId) ||
    gateway.dispatchId !== dispatchId ||
    gateway.transport !== 'unix' ||
    gateway.socketMode !== '0600' ||
    gateway.endpointSha256 !==
      sha256(join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId, 'gateway.sock')) ||
    !isDecimalIdentity(endpointIdentity.device) ||
    !isDecimalIdentity(endpointIdentity.inode) ||
    !isDecimalIdentity(endpointIdentity.uid) ||
    endpointIdentity.mode !== '0600' ||
    endpointIdentity.type !== 'socket' ||
    gateway.endpointIdentitySha256 !== sha256(JSON.stringify(endpointIdentity)) ||
    !isSha256(gateway.processIncarnationSha256) ||
    !sameStrings(allowedOperations, LAB_GATEWAY_ALLOWED_OPERATIONS) ||
    gateway.lifecycleSource !== 'injected-per-request' ||
    !isSha256(gateway.receiptSha256) ||
    gateway.receiptSha256 !== sha256(JSON.stringify(stableGateway))
  ) {
    throw new Error('Codex laboratory launch receipt gateway evidence is malformed.')
  }
  return gateway
}

function validateGatewayPolicyReceipt(
  value: unknown,
  dispatchId: string,
  gatewayPolicyId: unknown
): Readonly<Record<string, unknown>> {
  const policy = requireExactObject(value, 'gateway policy receipt', [
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
  const binding = requireExactObject(policy.binding, 'gateway lifecycle binding', [
    'runIdSha256',
    'taskIdSha256',
    'dispatchIdSha256',
    'terminalHandleSha256',
    'terminalPaneKeySha256'
  ])
  const allowedOperations = requireExactArray(policy.allowedOperations, 'gateway policy operations')
  const unwiredBoundaries = requireExactArray(policy.unwiredBoundaries, 'gateway policy boundaries')
  const stablePolicy = {
    schema: policy.schema,
    policyId: policy.policyId,
    binding,
    allowedOperations,
    state: policy.state,
    workerDoneAccepted: policy.workerDoneAccepted,
    unwiredBoundaries,
    sourcePolicyDigest: policy.sourcePolicyDigest
  }
  if (
    policy.schema !== 'orca.lab-gateway-policy-public.v1' ||
    policy.policyId !== gatewayPolicyId ||
    !Object.values(binding).every(isSha256) ||
    binding.dispatchIdSha256 !== sha256(dispatchId) ||
    !sameStrings(allowedOperations, LAB_GATEWAY_ALLOWED_OPERATIONS) ||
    policy.state !== 'active' ||
    policy.workerDoneAccepted !== false ||
    !sameStrings(unwiredBoundaries, LAB_GATEWAY_UNWIRED_BOUNDARIES) ||
    !isSha256(policy.sourcePolicyDigest) ||
    !isSha256(policy.receiptSha256) ||
    policy.receiptSha256 !== sha256(JSON.stringify(stablePolicy))
  ) {
    throw new Error('Codex laboratory launch receipt gateway policy evidence is malformed.')
  }
  return policy
}
