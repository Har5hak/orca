import { describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../../rpc/core'
import { OrchestrationDb } from '../db'
import { createRootDispatch } from '../db/root-dispatch-test-fixture'
import {
  LabGatewayRpcInvocationFailure,
  createLabGatewayRpcInvoker,
  createOrcaLabGatewayRpcInvoker,
  type LabGatewayRpcInvocationInput
} from './dispatch-gateway-rpc-invoker'
import { translateLabGatewayOperation } from './dispatch-gateway-translation'

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

  it('routes a translated worker check to its Dispatch mailbox without consuming mail', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const workerHandle = 'term_lab_worker'
      const workerPane = 'tab_lab_worker:77777777-7777-4777-8777-777777777777'
      const processIncarnation = 'runtime:lab-worker:1'
      const run = db.createRun({
        objective: 'Laboratory worker mailbox regression',
        coordinatorHandle: 'term_lab_coordinator',
        coordinatorPaneKey: 'tab_lab_coordinator:88888888-8888-4888-8888-888888888888'
      })
      const task = db.createTask({ runId: run.id, spec: 'Read Dispatch status mail' })
      const dispatch = createRootDispatch(db, task.id, workerHandle, workerPane)
      const dispatchCapability = db.mintDispatchCapability({
        dispatchId: dispatch.id,
        paneKey: workerPane,
        processIncarnation
      })
      const message = db.insertMessage({
        runId: run.id,
        from: 'term_lab_coordinator',
        to: `dispatch:${dispatch.id}`,
        subject: 'Continue the canary',
        type: 'status'
      })
      const runtime = new OrcaRuntimeService()
      runtime.setOrchestrationDb(db)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === workerHandle ? workerPane : null
      )
      vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
        handle === workerHandle ? processIncarnation : null
      )
      const translated = translateLabGatewayOperation(
        'worker.check',
        { wait: false },
        {
          runId: run.id,
          taskId: task.id,
          dispatchId: dispatch.id,
          terminalHandle: workerHandle,
          terminalPaneKey: workerPane
        }
      )

      expect(translated).toMatchObject({
        ok: true,
        rpc: {
          method: 'orchestration.check',
          params: {
            terminal: workerHandle,
            terminalPaneKey: workerPane,
            peek: true,
            unread: false,
            types: 'status,dispatch',
            wait: false
          }
        }
      })
      if (!translated.ok) {
        throw new Error('worker.check translation unexpectedly failed')
      }
      expect(translated.rpc.params).not.toHaveProperty('run')

      const result = await createOrcaLabGatewayRpcInvoker(runtime)({
        rpc: translated.rpc,
        dispatchCapability,
        processIncarnation,
        terminalPaneKey: workerPane,
        signal: new AbortController().signal
      })

      expect(result).toMatchObject({
        runId: run.id,
        dispatchId: dispatch.id,
        messages: [{ id: message.id, subject: 'Continue the canary', type: 'status' }],
        count: 1
      })
      expect(db.getMessageById(message.id)?.read).toBe(0)
      expect(db.getUnreadMessages(`dispatch:${dispatch.id}`).map((row) => row.id)).toEqual([
        message.id
      ])
    } finally {
      db.close()
    }
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
