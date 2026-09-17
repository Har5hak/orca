import { createHash, randomUUID } from 'node:crypto'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../../rpc/core'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../rpc/methods/orchestration'
import type { LabGatewayRpcInvocation } from './dispatch-gateway-server'

const LAB_GATEWAY_RPC_METHODS = Object.freeze([
  'orchestration.workerShow',
  'orchestration.check',
  'orchestration.send',
  'orchestration.ask'
] as const)
const LAB_GATEWAY_INTERNAL_AUTH_MARKER = 'lab-gateway-host-internal-no-transport-auth'
const allowedMethods = new Set<string>(LAB_GATEWAY_RPC_METHODS)

type LabGatewayDispatcher = Readonly<{
  dispatch(
    request: RpcRequest,
    options?: Readonly<{
      signal?: AbortSignal
      authenticatedCallerFingerprint?: string
    }>
  ): Promise<RpcResponse>
}>

export type LabGatewayRpcInvocationInput = Omit<LabGatewayRpcInvocation, 'rpc'> &
  Readonly<{
    rpc: Readonly<{ method: string; params: Readonly<Record<string, unknown>> }>
  }>

export class LabGatewayRpcInvocationFailure extends Error {
  readonly code = 'ORCA_LAB_GATEWAY_RPC_FAILED'

  constructor(readonly reason: 'invocation_invalid' | 'method_forbidden' | 'rpc_refused') {
    super(`Laboratory gateway RPC invocation failed: ${reason}`)
    this.name = 'LabGatewayRpcInvocationFailure'
  }
}

export function createLabGatewayRpcInvoker(
  dispatcher: LabGatewayDispatcher
): (invocation: LabGatewayRpcInvocationInput) => Promise<unknown> {
  return async (invocation) => {
    if (
      !invocation.processIncarnation.trim() ||
      !invocation.terminalPaneKey.trim() ||
      !invocation.dispatchCapability.trim()
    ) {
      throw new LabGatewayRpcInvocationFailure('invocation_invalid')
    }
    if (!allowedMethods.has(invocation.rpc.method)) {
      throw new LabGatewayRpcInvocationFailure('method_forbidden')
    }
    const requestId = `labgw_${randomUUID()}`
    const response = await dispatcher.dispatch(
      {
        id: requestId,
        authToken: LAB_GATEWAY_INTERNAL_AUTH_MARKER,
        method: invocation.rpc.method,
        params: invocation.rpc.params,
        orchestrationCapability: invocation.dispatchCapability,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: requestId
      },
      {
        signal: invocation.signal,
        authenticatedCallerFingerprint: `lab-gateway:${sha256(invocation.dispatchCapability)}`
      }
    )
    if (!response.ok || response.id !== requestId) {
      throw new LabGatewayRpcInvocationFailure('rpc_refused')
    }
    return response.result
  }
}

export function createOrcaLabGatewayRpcInvoker(
  runtime: OrcaRuntimeService
): (invocation: LabGatewayRpcInvocationInput) => Promise<unknown> {
  const methods = ORCHESTRATION_METHODS.filter((method) => allowedMethods.has(method.name))
  if (
    methods.length !== LAB_GATEWAY_RPC_METHODS.length ||
    LAB_GATEWAY_RPC_METHODS.some((name) => !methods.some((method) => method.name === name))
  ) {
    throw new LabGatewayRpcInvocationFailure('method_forbidden')
  }
  return createLabGatewayRpcInvoker(new RpcDispatcher({ runtime, methods }))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
