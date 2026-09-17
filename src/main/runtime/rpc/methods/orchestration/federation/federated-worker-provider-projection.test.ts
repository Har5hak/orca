import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FleetAgentStatusEvidence } from '../../../../../../shared/orchestration-fleet-agent-status-evidence'
import type { OrchestrationFleetWorker } from '../../../../../../shared/orchestration-fleet-projection'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/environment-transport'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { createFederationWorkerStartRequest as startRequest } from './federation-request.test-support'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'

describe('federated worker provider projection', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    const workerDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint',
        pairingRevision: 73
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: workerRuntime.getStatus(),
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        return (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId,
          orchestrationCapability: envelope?.orchestrationCapability
        })) as RuntimeRpcResponse<unknown>
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null
    )
    configureFederationWorkerRuntime(workerRuntime)
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Provider truth',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Audit provider projection', runId: run.id })
  }

  async function listProjection(runId: string) {
    const listed = await homeDispatcher.dispatch({
      id: `rpc_provider_list_${runId}`,
      authToken: 'coordinator-token',
      method: 'orchestration.workerList',
      params: { run: runId }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The registered worker-list RPC method defines this tested response projection.
    const result = listed as {
      result: { workers: { projection: OrchestrationFleetWorker }[] }
    }
    return result.result.workers[0]?.projection
  }

  async function listProvider(runId: string) {
    return (await listProjection(runId))?.provider
  }

  it('keeps the confirmed federated provider after live status disappears', async () => {
    const task = createHomeTask()
    const started = await homeDispatcher.dispatch(
      startRequest(task.id, {
        agent: 'cursor',
        model: 'gpt-5.3-codex',
        effort: 'high'
      })
    )

    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    const dispatch = homeDb.getDispatchContext(task.id)!
    expect(dispatch.host_scope).toBe(
      JSON.stringify({ kind: 'federated', targetId: 'environment_windows' })
    )
    expect(JSON.parse(homeDb.getWorkerDispatch(dispatch.id)!.start_options)).toMatchObject({
      launch: {
        effective: { agent: 'cursor', model: 'gpt-5.3-codex', effort: 'high' }
      }
    })
    vi.spyOn(homeRuntime, 'getOrchestrationFleetAgentStatusSnapshot').mockReturnValue([])

    await expect(listProvider(task.run_id)).resolves.toEqual({
      id: 'cursor',
      model: 'gpt-5.3-codex'
    })
    await expect(listProjection(task.run_id)).resolves.toMatchObject({
      host: { kind: 'remote', id: 'environment_windows' },
      providerTruth: {
        requested: {
          id: 'cursor',
          model: 'gpt-5.3-codex',
          effort: 'high',
          source: 'launch_request'
        },
        effective: {
          id: 'cursor',
          model: 'gpt-5.3-codex',
          effort: 'high',
          source: 'launch_receipt'
        },
        observed: null
      }
    })
  })

  it('does not fall back to requested preferences when effective is null', async () => {
    const task = createHomeTask()
    const response = await homeDispatcher.dispatch(
      startRequest(task.id, { agent: 'grok', model: 'unsupported-model' })
    )

    expect(response).toMatchObject({
      ok: true,
      result: {
        state: 'failed',
        launch: {
          requested: { agent: 'grok', model: 'unsupported-model', effort: null },
          effective: null
        }
      }
    })
    await expect(listProvider(task.run_id)).resolves.toEqual({ id: 'unknown', model: null })
  })

  it('prefers identity-matched observed provider truth over a confirmed launch', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    const terminalHandle = homeDb.getWorkerDispatch(dispatch.id)!.agent_terminal_handle!
    homeDb.recordWorkerLaunchReceipt(dispatch.id, {
      requested: { agent: 'claude', model: 'opus', effort: null },
      effective: { agent: 'claude', model: 'opus', effort: null }
    })
    vi.spyOn(homeRuntime, 'getOrchestrationFleetAgentStatusSnapshot').mockReturnValue([
      observedProvider(dispatch.id, terminalHandle)
    ])

    await expect(listProvider(task.run_id)).resolves.toEqual({
      id: 'codex',
      model: 'gpt-observed'
    })
    await expect(listProjection(task.run_id)).resolves.toMatchObject({
      providerTruth: {
        requested: {
          id: 'claude',
          model: 'opus',
          effort: null,
          source: 'launch_request'
        },
        effective: {
          id: 'claude',
          model: 'opus',
          effort: null,
          source: 'launch_receipt'
        },
        observed: {
          id: 'codex',
          model: 'gpt-observed',
          effort: null,
          source: 'agent_status',
          observedAt: expect.any(Number),
          freshness: 'fresh'
        }
      }
    })
  })

  it('accepts a true legacy row with nullable provider fields', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    homeDb.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(JSON.stringify({ agent: null, model: null }), dispatch.id)

    await expect(listProvider(task.run_id)).resolves.toEqual({ id: 'unknown', model: null })
  })

  it('fails closed when a launch receipt is present but malformed', async () => {
    const task = createHomeTask()
    await homeDispatcher.dispatch(startRequest(task.id))
    const dispatch = homeDb.getDispatchContext(task.id)!
    homeDb.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(JSON.stringify({ agent: 'claude', launch: 'malformed' }), dispatch.id)

    await expect(listProjection(task.run_id)).resolves.toMatchObject({
      provider: { id: 'unknown', model: null },
      providerTruth: { requested: null, effective: null, observed: null }
    })
  })
})

function observedProvider(dispatchId: string, terminalHandle: string): FleetAgentStatusEvidence {
  const observedAt = Date.now()
  return {
    binding: {
      kind: 'worker',
      dispatchId,
      paneKey: 'remote:observed',
      terminalHandle,
      processIncarnation: 'remote:pty:1'
    },
    clock: { kind: 'observed', at: observedAt },
    deliveredAt: observedAt,
    activity: {
      paneKey: 'remote:observed',
      connectionId: 'environment_windows',
      state: 'working',
      agentType: 'codex',
      model: 'gpt-observed',
      worktreeId: null,
      restoredUnconfirmed: false,
      providerSessionOnly: false
    }
  }
}
