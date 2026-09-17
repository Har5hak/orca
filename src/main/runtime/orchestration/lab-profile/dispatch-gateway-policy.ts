import {
  createLabGatewayPolicyReceipt,
  matchesLabGatewayCredential,
  type LabGatewayAdmission,
  type LabGatewayPolicy,
  type LabGatewayRefusalReason,
  type LabGatewayRequest
} from './dispatch-gateway-policy-contract'
import {
  deniedLabGatewayOperationReason,
  findCallerIdentityRefusal,
  isAllowedLabGatewayOperation,
  toLabGatewayParams
} from './dispatch-gateway-request-validation'
import { translateLabGatewayOperation } from './dispatch-gateway-translation'

export {
  LAB_GATEWAY_ALLOWED_OPERATIONS,
  LAB_GATEWAY_UNWIRED_BOUNDARIES,
  createLabGatewayPolicyReceipt,
  mintLabGatewayPolicy,
  revokeLabGatewayPolicy
} from './dispatch-gateway-policy-contract'
export type {
  LabGatewayAdmission,
  LabGatewayBinding,
  LabGatewayOperation,
  LabGatewayPolicy,
  LabGatewayPolicyReceipt,
  LabGatewayRefusalReason,
  LabGatewayRequest,
  LabGatewayRpc
} from './dispatch-gateway-policy-contract'

function refused(
  policy: LabGatewayPolicy,
  operation: string,
  reason: LabGatewayRefusalReason,
  field?: string
): LabGatewayAdmission {
  const message = `Laboratory gateway refused ${operation}: ${reason}`
  return {
    ok: false,
    refusal: field ? { reason, message, operation, field } : { reason, message, operation },
    nextPolicy: policy,
    receipt: createLabGatewayPolicyReceipt(policy)
  }
}

export function admitLabGatewayRequest(
  policy: LabGatewayPolicy,
  request: LabGatewayRequest
): LabGatewayAdmission {
  if (!matchesLabGatewayCredential(policy, request.credential)) {
    return refused(policy, request.operation, 'credential_invalid')
  }
  if (request.operation === 'worker.done' && policy.workerDoneAccepted) {
    return refused(policy, request.operation, 'worker_done_already_accepted')
  }
  if (policy.revoked) {
    return refused(policy, request.operation, 'credential_revoked')
  }
  if (policy.terminal) {
    return refused(policy, request.operation, 'policy_terminal')
  }
  if (!isAllowedLabGatewayOperation(request.operation)) {
    return refused(policy, request.operation, deniedLabGatewayOperationReason(request.operation))
  }
  const params = toLabGatewayParams(request.params)
  if (!params) {
    return refused(policy, request.operation, 'invalid_parameters')
  }
  const identityRefusal = findCallerIdentityRefusal(params, policy.binding)
  if (identityRefusal) {
    return refused(policy, request.operation, identityRefusal.reason, identityRefusal.field)
  }
  const translation = translateLabGatewayOperation(request.operation, params, policy.binding)
  if (!translation.ok) {
    return refused(policy, request.operation, 'invalid_parameters', translation.field)
  }
  const nextPolicy: LabGatewayPolicy = translation.terminal
    ? { ...policy, workerDoneAccepted: true, terminal: true }
    : policy
  return {
    ok: true,
    rpc: translation.rpc,
    nextPolicy,
    receipt: createLabGatewayPolicyReceipt(nextPolicy)
  }
}
