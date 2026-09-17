import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'
import { ORCHESTRATION_WORKER_LIST_METHOD } from '../worker/worker-list-method'
import { parseRemoteFederatedWorkerStartReceipt } from './federated-attach-receipt'

describe('federated worker start receipt validation', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  it('accepts a bounded future provider while preserving additive launch fields', () => {
    const parsed = parseRemoteFederatedWorkerStartReceipt({
      dispatchId: 'ctx_remote',
      state: 'outcome_unknown',
      futureReceiptField: true,
      launch: {
        futureLaunchField: true,
        requested: {
          agent: 'future-provider-v2',
          model: 'future-model',
          effort: null,
          futureSelectionField: true
        },
        effective: {
          agent: 'future-provider-v2',
          model: 'future-model',
          effort: null,
          futureSelectionField: true
        }
      }
    })
    expect(parsed).toMatchObject({ futureReceiptField: true })
    expect(parsed.launch).toEqual({
      futureLaunchField: true,
      requested: {
        agent: 'future-provider-v2',
        model: 'future-model',
        effort: null,
        futureSelectionField: true
      },
      effective: {
        agent: 'future-provider-v2',
        model: 'future-model',
        effort: null,
        futureSelectionField: true
      }
    })
  })

  it.each([
    ['over limit', 'x'.repeat(513)],
    ['escape', 'codex\u001b[31m'],
    ['OSC', 'codex\u001b]0;spoof\u0007'],
    ['CSI', 'codex\u009b31m'],
    ['newline', 'codex\nspoof'],
    ['C1 control', 'codex\u0085spoof'],
    ['bidi override', 'codex\u202espoof'],
    ['lone high surrogate', 'codex\ud800'],
    ['lone low surrogate', 'codex\udfff']
  ])('rejects a terminal-unsafe %s launch field', (_name, agent) => {
    expect(() =>
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'outcome_unknown',
        launch: {
          requested: { agent, model: null, effort: null },
          effective: null
        }
      })
    ).toThrow('invalid launch receipt')
  })

  it('rejects launch fields with surrounding whitespace instead of rewriting peer truth', () => {
    expect(() =>
      parseRemoteFederatedWorkerStartReceipt({
        dispatchId: 'ctx_remote',
        state: 'outcome_unknown',
        launch: {
          requested: { agent: ' codex ', model: ' gpt-test ', effort: null },
          effective: null
        }
      })
    ).toThrow('invalid launch receipt')
  })

  it('persists immutable home requested truth and additive peer effective truth', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'future provider receipt',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The attach-start call supplies the parsed RPC input containing dispatchId.
        const input = params as { dispatchId: string }
        return {
          dispatchId: input.dispatchId,
          state: 'ready',
          runtimeEpoch: 'remote_runtime_epoch',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote',
          launch: {
            futureLaunchField: true,
            requested: {
              agent: 'future-provider-v2',
              model: 'future-model',
              effort: null,
              futureSelectionField: true
            },
            effective: {
              agent: 'future-provider-v2',
              model: 'future-model',
              effort: null,
              futureSelectionField: true
            }
          }
        }
      }
    )

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This narrows the worker-start receipt shape under test.
    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        agent: 'codex'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'future_provider_launch',
        method: 'orchestration.workerStart',
        payloadHash: 'future_provider_payload'
      }
    })) as { dispatchId: string; state: string; launch: unknown }

    expect(result.state).toBe('ready')
    const persistedLaunch = JSON.parse(
      db.getWorkerDispatch(result.dispatchId)!.start_options
    ).launch
    expect(persistedLaunch).toEqual({
      futureLaunchField: true,
      requested: {
        agent: 'codex',
        model: null,
        effort: null,
        futureSelectionField: true
      },
      effective: {
        agent: 'future-provider-v2',
        model: 'future-model',
        effort: null,
        futureSelectionField: true
      }
    })
    expect(result.launch).toEqual(persistedLaunch)
  })

  it('marks a malformed ready receipt outcome unknown without persisting resources', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'federated worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The attach-start call supplies the parsed RPC input containing dispatchId.
        const input = params as { dispatchId: string }
        return {
          dispatchId: input.dispatchId,
          state: 'ready',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote'
        }
      })

    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        terminal: 'term_remote'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'remote_start',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })) as { dispatchId: string; state: string; lastError?: string }

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      lastError: 'The worker server returned an invalid ready receipt.'
    })
    expect(db.getFederatedDispatch(result.dispatchId)).toMatchObject({
      remote_runtime_epoch: null,
      remote_worktree_id: null,
      remote_terminal_handle: null
    })
    for (const call of remoteCall.mock.calls) {
      expect(call[5]).toEqual({
        ...(call[1] === 'orchestration.federationAttachStart' ? { contractVerified: true } : {}),
        expectedEnvironmentPairingRevision: 73
      })
    }
  })

  it.each([
    ['scalar', 'legacy'],
    ['array', []],
    [
      'partial',
      {
        requested: { agent: 'codex', model: null, effort: null }
      }
    ],
    [
      'control-character',
      {
        requested: { agent: 'codex\nspoof', model: null, effort: null },
        effective: null
      }
    ]
  ])('does not persist a malformed present %s launch receipt', async (_shape, launch) => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'malformed launch receipt',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          state: 'ready',
          runtimeEpoch: 'remote_runtime_epoch',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote',
          launch
        }
      }
    )

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This narrows the federated start receipt shape under test.
    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        agent: 'codex'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: `malformed_${_shape}_launch`,
        method: 'orchestration.workerStart',
        payloadHash: `malformed_${_shape}_payload`
      }
    })) as { dispatchId: string; state: string; lastError?: string }

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      lastError: 'The worker server returned an invalid launch receipt.'
    })
    expect(JSON.parse(db.getWorkerDispatch(result.dispatchId)!.start_options)).toMatchObject({
      launch: {
        requested: { agent: 'codex', model: null, effort: null },
        effective: null
      }
    })
    expect(db.getFederatedDispatch(result.dispatchId)).toMatchObject({
      remote_runtime_epoch: null,
      remote_worktree_id: null,
      remote_terminal_handle: null
    })
    expect(db.getWorkerTerminalResourceByOwner(result.dispatchId)).toBeUndefined()
  })

  it('does not persist a requested model when an older ready peer omits launch confirmation', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'legacy federated worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
            ]
          }
        }
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          state: 'ready',
          runtimeEpoch: 'legacy_runtime_epoch',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote'
        }
      }
    )

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This narrows the federated start receipt shape under test.
    const started = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        agent: 'cursor',
        model: 'gpt-5.3-codex'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'legacy_remote_start',
        method: 'orchestration.workerStart',
        payloadHash: 'legacy_payload'
      }
    })) as { dispatchId: string; launch: { effective: { model: string } | null } }
    expect(started.launch.effective).toBeNull()
    expect(JSON.parse(db.getWorkerDispatch(started.dispatchId)!.start_options)).toMatchObject({
      launch: { effective: null }
    })

    const listed = await ORCHESTRATION_WORKER_LIST_METHOD.handler(
      ORCHESTRATION_WORKER_LIST_METHOD.params!.parse({ run: run.id }),
      { runtime }
    )
    expect(listed.workers[0]?.projection.provider).toEqual({ id: 'unknown', model: null })
    expect(listed.workers[0]?.projection.providerTruth).toMatchObject({
      requested: {
        id: 'cursor',
        model: 'gpt-5.3-codex',
        effort: null,
        source: 'launch_request'
      },
      effective: null,
      observed: null
    })
  })
})
