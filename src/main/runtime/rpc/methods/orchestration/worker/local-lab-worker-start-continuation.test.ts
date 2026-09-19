import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { testCodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import { buildLabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server-receipt'
import { createLabGatewayPolicyReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-policy'
import {
  expectedCodexLabDispatchRuntimeRoot,
  sha256
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-validation'
import { registerCodexLabRuntimeCleanupAuthority } from '../../../../orchestration/lab-profile/codex-lab-runtime-cleanup-authority'
import { continuePreparedLocalLabWorkerStart } from './local-lab-worker-start-continuation'
import { LocalLabLaunchAuthorityPreparationRefusal } from './local-lab-launch-authority-contract'
import type { LocalLabWorkerContinuationDeps } from './local-lab-worker-start-continuation-contract'
import { publicCodexLabGatewayReceipt } from './local-codex-lab-launch-authority'
import {
  closeContinuationDatabases,
  harness as createHarness,
  IDENTITY,
  layoutRemovalEvidence,
  preparedAuthority,
  PROFILE,
  realPhaseAuthority as createRealPhaseAuthority,
  returningPreparedAuthority,
  structuredSessionFixture
} from './local-lab-worker-start-continuation.test-support'
import { stubCodexLabCustodyTransitions } from './local-lab-worker-start-continuation-custody.test-support'

function harness() {
  return createHarness(testCodexLabStructuredLaunchBinding())
}

function realPhaseAuthority(
  prepared: Parameters<typeof createRealPhaseAuthority>[0],
  rollbackIfUnclaimed?: Parameters<typeof createRealPhaseAuthority>[2],
  releaseCleanupRegistration?: Parameters<typeof createRealPhaseAuthority>[3]
) {
  return createRealPhaseAuthority(
    prepared,
    testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id }),
    rollbackIfUnclaimed,
    releaseCleanupRegistration
  )
}

type StubCustodyDb = Parameters<typeof stubCodexLabCustodyTransitions>[0]['db']
const CUSTODY_CONTEXT = Object.freeze({
  profile: PROFILE,
  identity: IDENTITY,
  configSha256ForDispatch: (dispatchId: string) =>
    testCodexLabStructuredLaunchBinding({ dispatchId }).plan.receiptInputs.configSha256
})

function stubCustodyTransitions(db: StubCustodyDb, events: string[]): void {
  stubCodexLabCustodyTransitions({ db, events, context: CUSTODY_CONTEXT })
}

afterEach(() => {
  closeContinuationDatabases()
})

function requireEffects(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Expected a worker continuation result object.')
  }
  const effects = Reflect.get(value, 'effects')
  if (!Array.isArray(effects)) {
    throw new Error('Expected worker continuation effects.')
  }
  return effects
}

function effectKindIs(effect: unknown, kind: string): boolean {
  return typeof effect === 'object' && effect !== null && Reflect.get(effect, 'kind') === kind
}

describe('local laboratory worker continuation', () => {
  it('persists the admitted capability receipt before the restricted preamble', async () => {
    const { db, runtime, run, prepared } = harness()
    const events: string[] = []
    stubCustodyTransitions(db, events)
    const postLeaseStatus = runtime.getStatus()
    vi.mocked(runtime.getStatus).mockReturnValue({
      ...postLeaseStatus,
      capabilities: postLeaseStatus.capabilities?.filter(
        (capability) => capability !== 'orchestration.lab-readonly-profile.v1'
      )
    })
    vi.mocked(runtime.getStatus).mockClear()
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: vi.fn(async ({ dispatchCapability, lifecycle }) => {
        expect(dispatchCapability).toMatch(/^dcap_/)
        events.push('host:prepared')
        const authority = preparedAuthority(
          testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id })
        )
        lifecycle.recordLayoutPrepared(authority.layoutEvidence)
        lifecycle.recordProviderReserved()
        lifecycle.recordGatewayStarted(authority.gatewayReceipt)
        return authority
      }),
      createStructuredSession: vi.fn(async (args) => {
        events.push('session:create')
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        events.push('session:attached')
        return structuredSessionFixture()
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

    const result = await continuePreparedLocalLabWorkerStart({
      prepared,
      runtime,
      db,
      run,
      coordinatorHandle: 'term_coord',
      deps
    })

    expect(result).toMatchObject({
      state: 'ready',
      turnStart: 'observed',
      launchReceipt: {
        capabilities: {
          supported: expect.arrayContaining(['orchestration.lab-readonly-profile.v1'])
        }
      }
    })
    expect(runtime.getStatus).not.toHaveBeenCalled()

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
      'custody:receipt',
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
      prepareLaunchAuthority: returningPreparedAuthority(
        testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id }),
        rollbackIfUnclaimed
      ),
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
        return structuredSessionFixture()
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
      prepareLaunchAuthority: returningPreparedAuthority(
        testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id }),
        rollbackIfUnclaimed
      ),
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

  it('releases the profile lease when provider attach fails before auth is claimed', async () => {
    const { db, runtime, run, prepared } = harness()
    const rollbackIfUnclaimed = vi.fn(async () => true)
    const releaseCleanupRegistration = vi.fn(() => true)
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async ({ lifecycle }) => {
        const authority = realPhaseAuthority(
          prepared,
          rollbackIfUnclaimed,
          releaseCleanupRegistration
        )
        lifecycle.recordLayoutPrepared(authority.layoutEvidence)
        lifecycle.recordProviderReserved()
        lifecycle.recordGatewayStarted(authority.gatewayReceipt)
        return authority
      },
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('injected pre-claim attach refusal')
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
      lastError: 'injected pre-claim attach refusal'
    })
    expect(rollbackIfUnclaimed).toHaveBeenCalledOnce()
    expect(releaseCleanupRegistration).toHaveBeenCalledOnce()
    expect(db.getCodexLabRuntimeCustody(prepared.started.dispatch.id)).toMatchObject({
      state: 'released'
    })
    expect(() =>
      db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 1,
        taskSpec: 'Retry after pre-claim attach refusal.',
        taskRunId: run.id,
        runtimeEpoch: 'runtime_task_757',
        startOptions: { profile: { id: PROFILE } },
        profileLease: { profileId: PROFILE }
      })
    ).not.toThrow()
  })

  it('reconciles a claimed provider only after exact process-exit proof', async () => {
    const { db, runtime, run, prepared } = harness()
    const events: string[] = []
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async ({ lifecycle }) => {
        const unregister = registerCodexLabRuntimeCleanupAuthority({
          dispatchId: prepared.started.dispatch.id,
          sessionId: IDENTITY.sessionId,
          terminalHandle: IDENTITY.handle,
          terminalPaneKey: IDENTITY.paneKey,
          processIncarnation: IDENTITY.processIncarnation,
          stopGateway: async () => {
            events.push('gateway:released')
          },
          removeLayout: async () => {
            events.push('layout:released')
            return layoutRemovalEvidence(prepared.started.dispatch.id)
          }
        })
        const authority = realPhaseAuthority(prepared, async () => false, unregister)
        lifecycle.recordLayoutPrepared(authority.layoutEvidence)
        lifecycle.recordProviderReserved()
        lifecycle.recordGatewayStarted(authority.gatewayReceipt)
        return authority
      },
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('injected claimed-provider refusal')
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
      lastError: 'injected claimed-provider refusal',
      residualResources: []
    })
    expect(runtime.inspectTerminalProcessIncarnationLiveness).toHaveBeenCalledWith(
      IDENTITY.processIncarnation,
      JSON.stringify(IDENTITY.hostScope)
    )
    expect(events).toEqual(['gateway:released', 'layout:released'])
    expect(db.getCodexLabRuntimeCustody(prepared.started.dispatch.id)).toMatchObject({
      state: 'released'
    })
    expect(() =>
      db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 1,
        taskSpec: 'Retry after claimed provider exit.',
        taskRunId: run.id,
        runtimeEpoch: 'runtime_task_757',
        startOptions: { profile: { id: PROFILE } },
        profileLease: { profileId: PROFILE }
      })
    ).not.toThrow()
  })

  it('releases full ready-stage custody after preamble failure and proven provider exit', async () => {
    const { db, runtime, run, prepared } = harness()
    const events: string[] = []
    vi.spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async ({ lifecycle }) => {
        const unregister = registerCodexLabRuntimeCleanupAuthority({
          dispatchId: prepared.started.dispatch.id,
          sessionId: IDENTITY.sessionId,
          terminalHandle: IDENTITY.handle,
          terminalPaneKey: IDENTITY.paneKey,
          processIncarnation: IDENTITY.processIncarnation,
          stopGateway: async () => {
            events.push('gateway:released')
          },
          removeLayout: async () => {
            events.push('layout:released')
            return layoutRemovalEvidence(prepared.started.dispatch.id)
          }
        })
        const authority = realPhaseAuthority(prepared, async () => false, unregister)
        lifecycle.recordLayoutPrepared(authority.layoutEvidence)
        lifecycle.recordProviderReserved()
        lifecycle.recordGatewayStarted(authority.gatewayReceipt)
        return authority
      },
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        return structuredSessionFixture()
      },
      deliverPreamble: async () => {
        throw new Error('injected preamble refusal after attach')
      },
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
      failedStage: 'dispatch_input',
      lastError: 'injected preamble refusal after attach',
      residualResources: []
    })
    expect(events).toEqual(['gateway:released', 'layout:released'])
    expect(db.getCodexLabRuntimeCustody(prepared.started.dispatch.id)).toMatchObject({
      state: 'released',
      cleanup: {
        provider: { state: 'released' },
        auth: { state: 'released' },
        gateway: { state: 'released' },
        layout: { state: 'released' }
      }
    })
    expect(() =>
      db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: 1,
        taskSpec: 'Retry after preamble refusal.',
        taskRunId: run.id,
        runtimeEpoch: 'runtime_task_757',
        startOptions: { profile: { id: PROFILE } },
        profileLease: { profileId: PROFILE }
      })
    ).not.toThrow()
  })

  it('preserves worker_done settlement that wins the acknowledged-preamble race', async () => {
    const { db, runtime, run, prepared } = harness()
    const events: string[] = []
    stubCustodyTransitions(db, events)
    const markReady = vi.spyOn(db, 'markWorkerDispatchReady')
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: returningPreparedAuthority(
        testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id })
      ),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        return structuredSessionFixture()
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

    const result = await continuePreparedLocalLabWorkerStart({
      prepared,
      runtime,
      db,
      run,
      coordinatorHandle: 'term_coord',
      deps
    })
    expect(result).toMatchObject({
      state: 'ready',
      stage: 'settled',
      workerOutcome: 'succeeded',
      turnStart: 'observed',
      effects: expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    })
    const effects = requireEffects(result)
    expect(effects.filter((effect) => effectKindIs(effect, 'terminal'))).toHaveLength(1)
    expect(effects.filter((effect) => effectKindIs(effect, 'dispatch_input'))).toHaveLength(1)
    expect(effects.filter((effect) => effectKindIs(effect, 'created_lab_runtime'))).toHaveLength(1)
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
      prepareLaunchAuthority: returningPreparedAuthority(
        testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id })
      ),
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        return structuredSessionFixture()
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
      prepareLaunchAuthority: returningPreparedAuthority(
        testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id }),
        async () => {
          throw new Error('rollback also failed')
        }
      ),
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

  it('releases durable pre-attach custody after cleanup-authority registration refuses', async () => {
    const { db, runtime, run, prepared } = harness()
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async () => {
        throw new LocalLabLaunchAuthorityPreparationRefusal(
          'Codex laboratory runtime cleanup authority conflicts or is invalid.',
          true
        )
      },
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('unreachable after host refusal')
      },
      deliverPreamble: vi.fn(async () => undefined),
      tearDownFailedStart: vi.fn(async () => undefined)
    }

    const outcome = await continuePreparedLocalLabWorkerStart({
      prepared,
      runtime,
      db,
      run,
      coordinatorHandle: 'term_coord',
      deps
    })
    expect(outcome).toMatchObject({
      state: 'failed',
      failedStage: 'lab_host_prepare',
      lastError: 'Codex laboratory runtime cleanup authority conflicts or is invalid.'
    })
    expect(outcome).not.toHaveProperty('cleanupErrors')
    expect(db.getCodexLabRuntimeCustody(prepared.started.dispatch.id)).toMatchObject({
      state: 'released'
    })

    const next = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 1,
      taskSpec: 'Retry after cleanup-authority registration refused.',
      taskRunId: run.id,
      runtimeEpoch: 'runtime_task_757',
      startOptions: { profile: { id: PROFILE } },
      profileLease: { profileId: PROFILE }
    })
    expect(next.dispatch.id).not.toBe(prepared.started.dispatch.id)
  })

  it.each(['layout', 'provider', 'gateway'] as const)(
    'releases phase-aligned %s custody after a proven before-attach rollback',
    async (failedAfter) => {
      const { db, runtime, run, prepared } = harness()
      const deps: LocalLabWorkerContinuationDeps = {
        prepareLaunchAuthority: async ({ lifecycle }) => {
          const dispatchId = prepared.started.dispatch.id
          lifecycle.recordLayoutPrepared({
            dispatchId,
            profileId: PROFILE,
            runtimeParentIdentity: { device: '1', inode: '2' },
            runtimeRootIdentity: { device: '1', inode: '3' },
            configSha256: 'd'.repeat(64)
          })
          if (failedAfter !== 'layout') {
            lifecycle.recordProviderReserved()
          }
          if (failedAfter === 'gateway') {
            const socketEvidence = Object.freeze({
              device: '1',
              inode: '4',
              uid: '501',
              mode: '0600' as const,
              type: 'socket' as const
            })
            lifecycle.recordGatewayStarted(
              publicCodexLabGatewayReceipt(
                buildLabGatewayServerReceipt(
                  join(expectedCodexLabDispatchRuntimeRoot(dispatchId), 'gateway.sock'),
                  IDENTITY.processIncarnation,
                  'lgp1_continuation-test',
                  dispatchId,
                  {
                    evidence: socketEvidence,
                    identitySha256: sha256(JSON.stringify(socketEvidence))
                  },
                  createLabGatewayPolicyReceipt({
                    schemaVersion: 1,
                    policyId: 'lgp1_continuation-test',
                    credentialSha256: 'a'.repeat(64),
                    binding: {
                      runId: prepared.started.dispatch.run_id,
                      taskId: prepared.started.dispatch.task_id,
                      dispatchId,
                      terminalHandle: IDENTITY.handle,
                      terminalPaneKey: IDENTITY.paneKey
                    },
                    revoked: false,
                    workerDoneAccepted: false,
                    terminal: false
                  })
                )
              )
            )
          }
          throw new LocalLabLaunchAuthorityPreparationRefusal(
            `injected clean ${failedAfter} refusal`,
            true
          )
        },
        createStructuredSession: async (args) => {
          if (!args.beforeAttach) {
            throw new Error('laboratory beforeAttach callback missing')
          }
          await args.beforeAttach(IDENTITY)
          throw new Error('unreachable after host refusal')
        },
        deliverPreamble: vi.fn(async () => undefined),
        tearDownFailedStart: vi.fn(async () => undefined)
      }

      const outcome = await continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })

      expect(outcome).toMatchObject({
        state: 'failed',
        failedStage: 'lab_host_prepare',
        lastError: `injected clean ${failedAfter} refusal`
      })
      expect(outcome).not.toHaveProperty('cleanupErrors')
      expect(db.getCodexLabRuntimeCustody(prepared.started.dispatch.id)).toMatchObject({
        state: 'released'
      })
      expect(db.getWorkerTerminalResourceByOwner(prepared.started.dispatch.id)).toMatchObject({
        ownership_state: 'released',
        release_state: 'released'
      })

      expect(() =>
        db.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: 1,
          taskSpec: `Retry after ${failedAfter} rollback.`,
          taskRunId: run.id,
          runtimeEpoch: 'runtime_task_757',
          startOptions: { profile: { id: PROFILE } },
          profileLease: { profileId: PROFILE }
        })
      ).not.toThrow()
    }
  )

  it('re-reads worker_done settlement that lands during awaited cleanup', async () => {
    const { db, runtime, run, prepared } = harness()
    stubCustodyTransitions(db, [])
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: returningPreparedAuthority(
        testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id }),
        async () => false
      ),
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
      prepareLaunchAuthority: returningPreparedAuthority(
        testCodexLabStructuredLaunchBinding({ dispatchId: prepared.started.dispatch.id }),
        async () => false
      ),
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
