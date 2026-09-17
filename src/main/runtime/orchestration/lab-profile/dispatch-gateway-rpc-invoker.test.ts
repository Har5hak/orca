import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import type { RpcRequest, RpcResponse } from '../../rpc/core'
import {
  LabGatewayRpcInvocationFailure,
  createLabGatewayRpcInvoker,
  type LabGatewayRpcInvocationInput
} from './dispatch-gateway-rpc-invoker'

const DISPATCH_CAPABILITY = `dcap_${'D'.repeat(43)}`

function invocation(
  overrides: Partial<LabGatewayRpcInvocationInput> = {}
): LabGatewayRpcInvocationInput {
  return {
    rpc: { method: 'orchestration.workerShow', params: { dispatch: 'dispatch_757' } },
    dispatchCapability: DISPATCH_CAPABILITY,
    processIncarnation: 'process_757',
    terminalPaneKey: 'pane_757',
    signal: new AbortController().signal,
    ...overrides
  }
}

describe('laboratory gateway in-process RPC invoker', () => {
  it('uses only Dispatch authority and a non-secret internal transport marker', async () => {
    let observedRequest: RpcRequest | undefined
    let observedOptions:
      | Readonly<{
          signal?: AbortSignal
          authenticatedCallerFingerprint?: string
        }>
      | undefined
    const dispatcher = {
      dispatch: vi.fn(async (request: RpcRequest, options?: typeof observedOptions) => {
        observedRequest = request
        observedOptions = options
        return success(request.id, { state: 'running' })
      })
    }
    const invoke = createLabGatewayRpcInvoker(dispatcher)

    await expect(invoke(invocation())).resolves.toEqual({ state: 'running' })

    expect(observedRequest).toMatchObject({
      authToken: 'lab-gateway-host-internal-no-transport-auth',
      method: 'orchestration.workerShow',
      params: { dispatch: 'dispatch_757' },
      orchestrationCapability: DISPATCH_CAPABILITY,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
    })
    expect(observedRequest?.orchestrationRequestId).toBe(observedRequest?.id)
    expect(observedOptions?.authenticatedCallerFingerprint).toMatch(/^lab-gateway:[a-f0-9]{64}$/u)
    expect(JSON.stringify(observedOptions)).not.toContain(DISPATCH_CAPABILITY)
  })

  it.each([
    'orchestration.workerShow',
    'orchestration.check',
    'orchestration.send',
    'orchestration.ask'
  ])('admits the exact translated method %s', async (method) => {
    const dispatcher = {
      dispatch: vi.fn(async (request: RpcRequest) => success(request.id, { accepted: true }))
    }
    const invoke = createLabGatewayRpcInvoker(dispatcher)

    await expect(
      invoke(
        invocation({
          rpc: { method, params: {} }
        })
      )
    ).resolves.toEqual({ accepted: true })
    expect(dispatcher.dispatch).toHaveBeenCalledOnce()
  })

  it('rejects a broadened RPC method before dispatcher invocation', async () => {
    const dispatcher = { dispatch: vi.fn() }
    const invoke = createLabGatewayRpcInvoker(dispatcher)
    const broadened = invocation({
      rpc: {
        method: 'orchestration.workerStart',
        params: {}
      }
    })

    await expect(invoke(broadened)).rejects.toEqual(
      new LabGatewayRpcInvocationFailure('method_forbidden')
    )
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })

  it('normalizes dispatcher refusal without exposing its message or data', async () => {
    const dispatcher = {
      dispatch: vi.fn(async (request: RpcRequest): Promise<RpcResponse> => ({
        id: request.id,
        ok: false,
        error: {
          code: 'forbidden',
          message: `leak ${DISPATCH_CAPABILITY}`,
          data: { credential: 'shared-secret' }
        },
        _meta: { runtimeId: 'runtime_757' }
      }))
    }
    const invoke = createLabGatewayRpcInvoker(dispatcher)

    const error = await invoke(invocation()).catch((caught: unknown) => caught)

    expect(error).toEqual(new LabGatewayRpcInvocationFailure('rpc_refused'))
    expect(JSON.stringify(error)).not.toContain(DISPATCH_CAPABILITY)
    expect(JSON.stringify(error)).not.toContain('shared-secret')
  })

  it('refuses missing host-bound identity before dispatcher invocation', async () => {
    const dispatcher = { dispatch: vi.fn() }
    const invoke = createLabGatewayRpcInvoker(dispatcher)

    await expect(invoke(invocation({ processIncarnation: '' }))).rejects.toEqual(
      new LabGatewayRpcInvocationFailure('invocation_invalid')
    )
    expect(dispatcher.dispatch).not.toHaveBeenCalled()
  })
})

function success(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result, _meta: { runtimeId: 'runtime_757' } }
}
