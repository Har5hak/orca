import { createHash } from 'node:crypto'
import type {
  LabUnixSocketEndpointAttestation,
  LabUnixSocketEndpointEvidence
} from '../../rpc/lab-unix-socket-lifecycle'
import { LAB_GATEWAY_ALLOWED_OPERATIONS, type LabGatewayOperation } from './dispatch-gateway-policy'

export type LabGatewayServerReceipt = Readonly<{
  schema: 'orca.lab-dispatch-gateway.v1'
  policyId: string
  dispatchId: string
  transport: 'unix'
  socketMode: '0600'
  endpointSha256: string
  endpointIdentity: LabUnixSocketEndpointEvidence
  endpointIdentitySha256: string
  processIncarnationSha256: string
  allowedOperations: readonly LabGatewayOperation[]
  lifecycleSource: 'injected-per-request'
  dcapCustody: 'server-only'
  receiptSha256: string
}>

export function buildLabGatewayServerReceipt(
  endpoint: string,
  processIncarnation: string,
  policyId: string,
  dispatchId: string,
  endpointAttestation: LabUnixSocketEndpointAttestation
): LabGatewayServerReceipt {
  const stable = Object.freeze({
    schema: 'orca.lab-dispatch-gateway.v1' as const,
    policyId,
    dispatchId,
    transport: 'unix' as const,
    socketMode: '0600' as const,
    endpointSha256: sha256(endpoint),
    endpointIdentity: Object.freeze({ ...endpointAttestation.evidence }),
    endpointIdentitySha256: endpointAttestation.identitySha256,
    processIncarnationSha256: sha256(processIncarnation),
    allowedOperations: Object.freeze([...LAB_GATEWAY_ALLOWED_OPERATIONS]),
    lifecycleSource: 'injected-per-request' as const,
    dcapCustody: 'server-only' as const
  })
  return Object.freeze({ ...stable, receiptSha256: sha256(JSON.stringify(stable)) })
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
