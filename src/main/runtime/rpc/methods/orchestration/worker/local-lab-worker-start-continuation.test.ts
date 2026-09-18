import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { testCodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import type { CodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import {
  continuePreparedLocalLabWorkerStart,
  type LocalLabWorkerContinuationDeps
} from './local-lab-worker-start-continuation'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import type { LabWorkerStartAdmission } from './worker-start-profile-admission'

const PROFILE = 'lab-readonly-supervised-v1'
const WORKTREE_PATH = '/private/tmp/orca-lab/disposable-structured'
const IDENTITY: StructuredWorkerIdentity = Object.freeze({
  handle: 'structworker_11111111-1111-4111-8111-111111111111',
  sessionId: '11111111-1111-4111-8111-111111111111',
  agent: 'codex',
  paneKey:
    'agent-session-11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  processIncarnation: 'structured:11111111-1111-4111-8111-111111111111',
  worktreeId: 'repo::disposable-structured',
  hostScope: Object.freeze({ kind: 'local', hostId: 'local' })
})

const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function harness() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('runtime_task_757')
  const run = db.createRun({
    objective: 'N=1 lab canary',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 1,
    taskSpec: 'Read the assigned repository and report one finding.',
    taskRunId: run.id,
    runtimeEpoch: 'runtime_task_757',
    startOptions: { profile: { id: PROFILE } },
    profileLease: { profileId: PROFILE }
  })
  const resource = Object.freeze({ kind: 'created_lab_runtime', id: started.dispatch.id })
  const worker = db.recordWorkerStage({
    dispatchId: started.dispatch.id,
    stage: 'lab_runtime_planned',
    effects: [resource],
    residualResources: [resource]
  })
  const admission: LabWorkerStartAdmission = Object.freeze({
    profile: PROFILE,
    adapter: 'codex-workspace-chatgpt-v1',
    agent: 'codex',
    maxConcurrency: 1,
    worktreeIdentity: 'wt2:local:disposable-structured',
    worktreeInstanceId: 'disposable-structured',
    expectedWorktreePath: WORKTREE_PATH
  })
  const prepared: PreparedLocalLabWorkerStart = Object.freeze({
    started: Object.freeze({ ...started, worker }),
    worktree: {
      id: IDENTITY.worktreeId,
      instanceId: 'disposable-structured',
      identity: {
        key: admission.worktreeIdentity,
        executionHostId: 'local',
        instanceId: admission.worktreeInstanceId
      },
      repoId: 'repo',
      path: WORKTREE_PATH,
      head: '1'.repeat(40),
      branch: 'task-757',
      isBare: false,
      isMainWorktree: false,
      displayName: 'disposable-structured',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1
    },
    observation: testCodexLabStructuredLaunchBinding().worktree,
    admission
  })
  return { db, runtime, run, prepared }
}

function stubCustodyTransitions(db: OrchestrationDb, events: string[]): void {
  vi.spyOn(db, 'planCodexLabRuntimeCustody').mockImplementation((input) => {
    events.push('custody:planned')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['planCodexLabRuntimeCustody']
    >
  })
  vi.spyOn(db, 'recordCodexLabRuntimeAuthorityAttached').mockImplementation((input) => {
    events.push('custody:authority')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['recordCodexLabRuntimeAuthorityAttached']
    >
  })
  vi.spyOn(db, 'recordCodexLabRuntimeLayoutPrepared').mockImplementation((input) => {
    events.push('custody:layout')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['recordCodexLabRuntimeLayoutPrepared']
    >
  })
  vi.spyOn(db, 'recordCodexLabRuntimeProviderReserved').mockImplementation((input) => {
    events.push('custody:provider-reserved')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['recordCodexLabRuntimeProviderReserved']
    >
  })
  vi.spyOn(db, 'recordCodexLabRuntimeGatewayStarted').mockImplementation((input) => {
    events.push('custody:gateway')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['recordCodexLabRuntimeGatewayStarted']
    >
  })
  vi.spyOn(db, 'recordCodexLabRuntimeExternalAuthInstalled').mockImplementation((input) => {
    events.push('custody:auth')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['recordCodexLabRuntimeExternalAuthInstalled']
    >
  })
  vi.spyOn(db, 'recordCodexLabRuntimeProviderAttached').mockImplementation((input) => {
    events.push('custody:provider')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['recordCodexLabRuntimeProviderAttached']
    >
  })
  vi.spyOn(db, 'recordCodexLabRuntimeReady').mockImplementation((input) => {
    events.push('custody:ready')
    return { dispatchId: input.dispatchId } as ReturnType<
      OrchestrationDb['recordCodexLabRuntimeReady']
    >
  })
}

function preparedAuthority(
  binding: CodexLabStructuredLaunchBinding,
  rollbackIfUnclaimed: () => Promise<boolean> = vi.fn(async () => true)
) {
  return {
    labLaunchBinding: binding,
    layoutEvidence: {
      dispatchId: binding.dispatchId,
      profileId: PROFILE,
      runtimeParentIdentity: { device: '1', inode: '2' },
      runtimeRootIdentity: { device: '1', inode: '3' },
      configSha256: binding.plan.receiptInputs.configSha256
    },
    gatewayReceipt: {
      schema: 'orca.lab-dispatch-gateway.v1' as const,
      policyId: 'lgp1_test',
      dispatchId: binding.dispatchId,
      transport: 'unix' as const,
      socketMode: '0600' as const,
      endpointSha256: binding.plan.receiptInputs.gatewaySocketPathSha256,
      endpointIdentity: {
        device: '1',
        inode: '4',
        uid: '501',
        mode: '0600' as const,
        type: 'socket' as const
      },
      endpointIdentitySha256: 'a'.repeat(64),
      processIncarnationSha256: 'b'.repeat(64),
      allowedOperations: ['worker.done', 'worker.ask', 'worker.check'] as const,
      lifecycleSource: 'injected-per-request' as const,
      dcapCustody: 'server-only' as const,
      receiptSha256: 'c'.repeat(64)
    },
    rollbackIfUnclaimed
  }
}

describe('local laboratory worker continuation', () => {
  it('attaches authority before host preparation and sends only the restricted preamble', async () => {
    const { db, runtime, run, prepared } = harness()
    const events: string[] = []
    stubCustodyTransitions(db, events)
    const binding = testCodexLabStructuredLaunchBinding()
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: vi.fn(async ({ dispatchCapability }) => {
        expect(dispatchCapability).toMatch(/^dcap_/)
        events.push('host:prepared')
        return preparedAuthority(binding)
      }),
      createStructuredSession: vi.fn(async (args) => {
        events.push('session:create')
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        events.push('session:attached')
        return { identity: IDENTITY, host: {} } as Awaited<
          ReturnType<NonNullable<LocalLabWorkerContinuationDeps['createStructuredSession']>>
        >
      }),
      deliverPreamble: vi.fn(async (args) => {
        expect(args).toEqual({
          delivery: 'lab-structured-only',
          structuredSession: expect.objectContaining({ identity: IDENTITY }),
          dispatchId: prepared.started.dispatch.id,
          taskSpec: prepared.started.task.spec
        })
        events.push('preamble')
        return undefined
      }),
      tearDownFailedStart: vi.fn(async () => undefined)
    }

    await expect(
      continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })
    ).resolves.toMatchObject({ state: 'ready', turnStart: 'observed' })

    expect(events).toEqual([
      'custody:planned',
      'session:create',
      'custody:authority',
      'host:prepared',
      'custody:layout',
      'custody:provider-reserved',
      'custody:gateway',
      'session:attached',
      'custody:auth',
      'custody:provider',
      'preamble',
      'custody:ready'
    ])
  })

  it('requests session teardown but retains exit-custodied authority after attach', async () => {
    const { db, runtime, run, prepared } = harness()
    const events: string[] = []
    stubCustodyTransitions(db, events)
    const rollbackIfUnclaimed = vi.fn(async () => {
      events.push('host:released')
      return true
    })
    const tearDownFailedStart = vi.fn(async () => {
      events.push('session:released')
    })
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () =>
        preparedAuthority(testCodexLabStructuredLaunchBinding(), rollbackIfUnclaimed),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        args.effects.push({
          kind: 'terminal',
          role: 'agent',
          action: 'created',
          id: IDENTITY.handle,
          surface: 'background'
        })
        return { identity: IDENTITY, host: {} } as Awaited<
          ReturnType<NonNullable<LocalLabWorkerContinuationDeps['createStructuredSession']>>
        >
      },
      deliverPreamble: async () => {
        throw new Error('injected preamble refusal')
      },
      tearDownFailedStart
    }

    await expect(
      continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })
    ).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'dispatch_input',
      lastError: 'injected preamble refusal'
    })
    expect(events.at(-1)).toBe('session:released')
    expect(rollbackIfUnclaimed).not.toHaveBeenCalled()
    expect(tearDownFailedStart).toHaveBeenCalledOnce()
  })

  it('rolls back host authority when preparation succeeds but provider attach fails', async () => {
    const { db, runtime, run, prepared } = harness()
    stubCustodyTransitions(db, [])
    const rollbackIfUnclaimed = vi.fn(async () => false)
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () =>
        preparedAuthority(testCodexLabStructuredLaunchBinding(), rollbackIfUnclaimed),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('injected provider attach failure')
      },
      deliverPreamble: vi.fn(async () => undefined),
      tearDownFailedStart: vi.fn(async () => undefined)
    }

    await expect(
      continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })
    ).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'provider_attach',
      lastError: 'injected provider attach failure'
    })
    expect(rollbackIfUnclaimed).toHaveBeenCalledOnce()
    expect(rollbackIfUnclaimed).toHaveResolvedWith(false)
  })

  it('preserves worker_done settlement that wins the acknowledged-preamble race', async () => {
    const { db, runtime, run, prepared } = harness()
    const events: string[] = []
    stubCustodyTransitions(db, events)
    const markReady = vi.spyOn(db, 'markWorkerDispatchReady')
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () => preparedAuthority(testCodexLabStructuredLaunchBinding()),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        return { identity: IDENTITY, host: {} } as Awaited<
          ReturnType<NonNullable<LocalLabWorkerContinuationDeps['createStructuredSession']>>
        >
      },
      deliverPreamble: async () => {
        db.settleWorkerReport({
          taskId: prepared.started.task.id,
          dispatchId: prepared.started.dispatch.id,
          outcome: 'succeeded',
          result: 'fast worker_done'
        })
        return undefined
      },
      tearDownFailedStart: vi.fn(async () => undefined)
    }

    const result = (await continuePreparedLocalLabWorkerStart({
      prepared,
      runtime,
      db,
      run,
      coordinatorHandle: 'term_coord',
      deps
    })) as { effects: { kind?: string; action?: string; state?: string }[] }
    expect(result).toMatchObject({
      state: 'ready',
      stage: 'settled',
      workerOutcome: 'succeeded',
      turnStart: 'observed',
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    })
    expect(result.effects.filter((effect) => effect.kind === 'terminal')).toHaveLength(1)
    expect(result.effects.filter((effect) => effect.kind === 'dispatch_input')).toHaveLength(1)
    expect(result.effects.filter((effect) => effect.kind === 'created_lab_runtime')).toHaveLength(1)
    expect(markReady).not.toHaveBeenCalled()
    expect(events).not.toContain('custody:ready')
    expect(db.getWorkerDispatch(prepared.started.dispatch.id)).toMatchObject({
      state: 'succeeded',
      stage: 'settled'
    })
  })

  it('settles the failed start even when structured-session teardown rejects', async () => {
    const { db, runtime, run, prepared } = harness()
    stubCustodyTransitions(db, [])
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () => preparedAuthority(testCodexLabStructuredLaunchBinding()),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        return { identity: IDENTITY, host: {} } as Awaited<
          ReturnType<NonNullable<LocalLabWorkerContinuationDeps['createStructuredSession']>>
        >
      },
      deliverPreamble: async () => {
        throw new Error('primary preamble failure')
      },
      tearDownFailedStart: async () => {
        throw new Error('teardown also failed')
      }
    }

    await expect(
      continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })
    ).resolves.toMatchObject({
      state: 'failed',
      lastError: 'primary preamble failure',
      cleanupErrors: ['teardown also failed']
    })
    expect(db.getWorkerDispatch(prepared.started.dispatch.id)).toMatchObject({ state: 'failed' })
  })

  it('settles the failed start even when unclaimed-authority rollback rejects', async () => {
    const { db, runtime, run, prepared } = harness()
    stubCustodyTransitions(db, [])
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () =>
        preparedAuthority(testCodexLabStructuredLaunchBinding(), async () => {
          throw new Error('rollback also failed')
        }),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('primary attach failure')
      },
      deliverPreamble: vi.fn(async () => undefined),
      tearDownFailedStart: async () => {
        throw new Error('teardown also failed')
      }
    }

    await expect(
      continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })
    ).resolves.toMatchObject({
      state: 'failed',
      lastError: 'primary attach failure',
      cleanupErrors: ['teardown also failed', 'rollback also failed']
    })
    expect(db.getWorkerDispatch(prepared.started.dispatch.id)).toMatchObject({ state: 'failed' })
  })

  it('re-reads worker_done settlement that lands during awaited cleanup', async () => {
    const { db, runtime, run, prepared } = harness()
    stubCustodyTransitions(db, [])
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () =>
        preparedAuthority(testCodexLabStructuredLaunchBinding(), async () => false),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('attach failed while settlement raced')
      },
      deliverPreamble: vi.fn(async () => undefined),
      tearDownFailedStart: async () => {
        db.markWorkerDispatchReady(prepared.started.dispatch.id, [])
        db.settleWorkerReport({
          taskId: prepared.started.task.id,
          dispatchId: prepared.started.dispatch.id,
          outcome: 'succeeded',
          result: 'settled during cleanup'
        })
      }
    }

    await expect(
      continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })
    ).resolves.toMatchObject({
      state: 'ready',
      stage: 'settled',
      workerOutcome: 'succeeded'
    })
    expect(db.getWorkerDispatch(prepared.started.dispatch.id)).toMatchObject({
      state: 'succeeded'
    })
  })

  it('reports a stopped cleanup race as stopped rather than a successful ready outcome', async () => {
    const { db, runtime, run, prepared } = harness()
    stubCustodyTransitions(db, [])
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () =>
        preparedAuthority(testCodexLabStructuredLaunchBinding(), async () => false),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('attach failed while stop raced')
      },
      deliverPreamble: vi.fn(async () => undefined),
      tearDownFailedStart: async () => {
        db.markWorkerDispatchReady(prepared.started.dispatch.id, [])
        db.beginWorkerStop(prepared.started.dispatch.id, 'runtime_task_757')
        db.settleWorkerStop(prepared.started.dispatch.id)
      }
    }

    const result = await continuePreparedLocalLabWorkerStart({
      prepared,
      runtime,
      db,
      run,
      coordinatorHandle: 'term_coord',
      deps
    })
    expect(result).toMatchObject({ state: 'stopped', stage: 'process_stopped' })
    expect(result).not.toHaveProperty('workerOutcome')
  })
})
