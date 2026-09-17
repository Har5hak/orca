import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const LAB_GATEWAY_ALLOWED_OPERATIONS = [
  'worker.status',
  'worker.check',
  'worker.heartbeat',
  'worker.ask',
  'worker.reply.consume',
  'worker.done'
] as const

export const LAB_GATEWAY_UNWIRED_BOUNDARIES = [
  'unix-socket-server',
  'persistent-replay',
  'persistent-revocation',
  'cleanup-saga',
  'database-integration'
] as const

export type LabGatewayOperation = (typeof LAB_GATEWAY_ALLOWED_OPERATIONS)[number]

export type LabGatewayBinding = Readonly<{
  runId: string
  taskId: string
  dispatchId: string
  terminalHandle: string
  terminalPaneKey: string
}>

export type LabGatewayPolicy = Readonly<{
  schemaVersion: 1
  policyId: string
  credentialSha256: string
  binding: LabGatewayBinding
  revoked: boolean
  workerDoneAccepted: boolean
  terminal: boolean
}>

export type LabGatewayPolicyReceipt = Readonly<{
  schemaVersion: 1
  policyId: string
  binding: LabGatewayBinding
  allowedOperations: typeof LAB_GATEWAY_ALLOWED_OPERATIONS
  state: 'active' | 'revoked' | 'terminal'
  workerDoneAccepted: boolean
  unwiredBoundaries: typeof LAB_GATEWAY_UNWIRED_BOUNDARIES
  policyDigest: string
}>

export type LabGatewayRefusalReason =
  | 'credential_invalid'
  | 'credential_revoked'
  | 'policy_terminal'
  | 'worker_done_already_accepted'
  | 'cross_dispatch_identity'
  | 'caller_identity_forbidden'
  | 'arbitrary_send_forbidden'
  | 'lifecycle_creation_forbidden'
  | 'lifecycle_mutation_forbidden'
  | 'raw_terminal_forbidden'
  | 'unknown_operation'
  | 'invalid_parameters'

export type LabGatewayRpc = Readonly<{
  method:
    | 'orchestration.workerShow'
    | 'orchestration.check'
    | 'orchestration.send'
    | 'orchestration.ask'
  params: Readonly<Record<string, unknown>>
}>

export type LabGatewayAdmission =
  | Readonly<{
      ok: true
      rpc: LabGatewayRpc
      nextPolicy: LabGatewayPolicy
      receipt: LabGatewayPolicyReceipt
    }>
  | Readonly<{
      ok: false
      refusal: Readonly<{
        reason: LabGatewayRefusalReason
        message: string
        operation: string
        field?: string
      }>
      nextPolicy: LabGatewayPolicy
      receipt: LabGatewayPolicyReceipt
    }>

export type LabGatewayRequest = Readonly<{
  credential: string
  operation: string
  params?: unknown
}>

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function policyState(policy: LabGatewayPolicy): LabGatewayPolicyReceipt['state'] {
  if (policy.revoked) {
    return 'revoked'
  }
  if (policy.terminal) {
    return 'terminal'
  }
  return 'active'
}

export function createLabGatewayPolicyReceipt(policy: LabGatewayPolicy): LabGatewayPolicyReceipt {
  const stableFields = {
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    binding: policy.binding,
    allowedOperations: LAB_GATEWAY_ALLOWED_OPERATIONS,
    state: policyState(policy),
    workerDoneAccepted: policy.workerDoneAccepted,
    unwiredBoundaries: LAB_GATEWAY_UNWIRED_BOUNDARIES
  } as const
  return { ...stableFields, policyDigest: sha256(JSON.stringify(stableFields)) }
}

function assertBinding(binding: LabGatewayBinding): void {
  for (const [field, value] of Object.entries(binding)) {
    if (!value.trim()) {
      throw new Error(`Laboratory gateway ${field} must be non-empty`)
    }
  }
}

export function mintLabGatewayPolicy(
  binding: LabGatewayBinding,
  entropySource: () => Uint8Array = () => randomBytes(32)
): Readonly<{
  credential: string
  policy: LabGatewayPolicy
  receipt: LabGatewayPolicyReceipt
}> {
  assertBinding(binding)
  const entropy = entropySource()
  if (entropy.byteLength < 32) {
    throw new Error('Laboratory gateway credentials require at least 32 bytes of entropy')
  }
  const credential = `lgw1_${Buffer.from(entropy).toString('base64url')}`
  const credentialSha256 = sha256(credential)
  const policy: LabGatewayPolicy = {
    schemaVersion: 1,
    policyId: `lgp1_${sha256(`${JSON.stringify(binding)}:${credentialSha256}`).slice(0, 24)}`,
    credentialSha256,
    binding: { ...binding },
    revoked: false,
    workerDoneAccepted: false,
    terminal: false
  }
  return { credential, policy, receipt: createLabGatewayPolicyReceipt(policy) }
}

export function revokeLabGatewayPolicy(policy: LabGatewayPolicy): LabGatewayPolicy {
  return policy.revoked ? policy : { ...policy, revoked: true }
}

export function matchesLabGatewayCredential(policy: LabGatewayPolicy, credential: string): boolean {
  const expected = Buffer.from(policy.credentialSha256, 'hex')
  const actual = Buffer.from(sha256(credential), 'hex')
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual)
}
