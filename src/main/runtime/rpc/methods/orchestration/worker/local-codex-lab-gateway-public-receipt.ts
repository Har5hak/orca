import { createHash } from 'node:crypto'
import type { CodexLabGatewayPublicReceipt } from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-contract'
import type { LabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server'

export function publicCodexLabGatewayReceipt(
  receipt: LabGatewayServerReceipt
): CodexLabGatewayPublicReceipt {
  const binding = receipt.policyReceipt.binding
  const publicPolicyStable = Object.freeze({
    schema: 'orca.lab-gateway-policy-public.v1' as const,
    policyId: receipt.policyReceipt.policyId,
    binding: Object.freeze({
      runIdSha256: sha256(binding.runId),
      taskIdSha256: sha256(binding.taskId),
      dispatchIdSha256: sha256(binding.dispatchId),
      terminalHandleSha256: sha256(binding.terminalHandle),
      terminalPaneKeySha256: sha256(binding.terminalPaneKey)
    }),
    allowedOperations: receipt.policyReceipt.allowedOperations,
    state: 'active' as const,
    workerDoneAccepted: false as const,
    unwiredBoundaries: receipt.policyReceipt.unwiredBoundaries,
    sourcePolicyDigest: receipt.policyReceipt.policyDigest
  })
  const policyReceipt = Object.freeze({
    ...publicPolicyStable,
    receiptSha256: sha256(JSON.stringify(publicPolicyStable))
  })
  const publicStable = Object.freeze({
    schema: receipt.schema,
    policyId: receipt.policyId,
    dispatchId: receipt.dispatchId,
    transport: receipt.transport,
    socketMode: receipt.socketMode,
    endpointSha256: receipt.endpointSha256,
    endpointIdentity: receipt.endpointIdentity,
    endpointIdentitySha256: receipt.endpointIdentitySha256,
    processIncarnationSha256: receipt.processIncarnationSha256,
    policyReceipt,
    allowedOperations: receipt.allowedOperations,
    lifecycleSource: receipt.lifecycleSource
  })
  const stableWithServerCustody = Object.freeze({
    ...publicStable,
    dcapCustody: 'server-only' as const
  })
  return Object.freeze({
    ...publicStable,
    receiptSha256: sha256(JSON.stringify(stableWithServerCustody))
  })
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
