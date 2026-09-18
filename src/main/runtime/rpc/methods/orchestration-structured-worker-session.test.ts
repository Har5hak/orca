import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchWriteFailureReason } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { OrchestrationDb } from '../../orchestration/db'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'

const hostRef: { current: unknown } = { current: null }
const createSpy = vi.fn()
const sessionIdMint = vi.hoisted(() => vi.fn())
let sessionSequence = 0
const startingDbTarget = new OrchestrationDb(':memory:')
const startingDb = new Proxy(startingDbTarget, {
  get(target, property, receiver) {
    if (property === 'getDispatchContextById') {
      return () => ({ status: 'pending' })
    }
    if (property === 'getWorkerDispatch') {
      return () => ({ state: 'starting' })
    }
    return Reflect.get(target, property, receiver)
  }
})

afterAll(() => startingDbTarget.close())

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createSpy(...args)
}))
vi.mock('./structured-worker-session-id', () => ({
  mintStructuredWorkerSessionId: () => sessionIdMint()
}))

const {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession,
  sendStructuredWorkerPreamble,
  structuredWorkerHoldId
} = await import('./orchestration-structured-worker-session')
const { isUnknownWorkerStartOutcome } = await import('./orchestration/worker/worker-topology')
const { structuredWorkerIdentities } = await import('../../structured-worker-identity')
const { structuredWorkerChildIdentityEnv } =
  await import('../../structured-worker-child-identity-env')

function installHost() {
  const hold = vi.fn(async () => {})
  const release = vi.fn()
  const dispose = vi.fn()
  const close = vi.fn(async () => {})
  hostRef.current = {
    setSessionTabVisibility: async () => {},
    close,
    deps: {
      store: {
        getRecord: () => ({
          location: { executionHostId: 'local', wslDistro: null },
          lease: { runtimeFence: 2, runtimeKind: 'native', claimStatus: 'live' }
        })
      }
    },
    hold,
    release,
    subscribe: () => dispose
  }
  return { hold, release, dispose, close }
}

describe('structured worker session hold', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    sessionIdMint.mockReset()
    sessionIdMint.mockImplementation(() => `session_test_${++sessionSequence}`)
    createSpy.mockReset()
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => ({
      ok: true,
      value: { sessionId: args.envelope.sessionId }
    }))
  })

  it('does not retain a start reservation when session-id minting throws', async () => {
    installHost()
    sessionIdMint
      .mockImplementationOnce(() => {
        throw new Error('uuid unavailable')
      })
      .mockReturnValueOnce('session_retry_after_uuid_failure')
    const args = {
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'codex' as const,
      dispatchId: 'd_uuid_retry',
      onJournalActivity: () => {}
    }

    await expect(createStructuredWorkerSession(args)).rejects.toThrow('uuid unavailable')
    const retried = await createStructuredWorkerSession(args)

    expect(retried.identity.sessionId).toBe('session_retry_after_uuid_failure')
    expect(createSpy).toHaveBeenCalledOnce()
    releaseStructuredWorkerSession('d_uuid_retry')
  })

  it('refuses release-before-reserve replay from durable settled lifecycle state', async () => {
    installHost()
    const db = new OrchestrationDb(':memory:')
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'durable release-before-reserve proof',
      taskRunId: 'run_legacy_local',
      startOptions: { agent: 'codex' }
    })
    const registerIdentity = vi.spyOn(structuredWorkerIdentities, 'register')
    const args = {
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db,
      worktreeId: 'wt_1',
      agent: 'codex' as const,
      dispatchId: started.dispatch.id,
      onJournalActivity: () => {}
    }

    releaseStructuredWorkerSession(args.dispatchId)
    db.abandonWorkerDispatch(args.dispatchId)
    try {
      await expect(createStructuredWorkerSession(args)).rejects.toMatchObject({
        code: 'dispatch_inactive'
      })
      await expect(createStructuredWorkerSession(args)).rejects.toMatchObject({
        code: 'dispatch_inactive'
      })
      expect(sessionIdMint).not.toHaveBeenCalled()
      expect(registerIdentity).not.toHaveBeenCalled()
      expect(createSpy).not.toHaveBeenCalled()
    } finally {
      registerIdentity.mockRestore()
      db.close()
    }
  })

  it('refuses reuse after release by re-reading durable settled lifecycle state', async () => {
    installHost()
    const db = new OrchestrationDb(':memory:')
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'durable reuse-after-release proof',
      taskRunId: 'run_legacy_local',
      startOptions: { agent: 'codex' }
    })
    const args = {
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db,
      worktreeId: 'wt_1',
      agent: 'codex' as const,
      dispatchId: started.dispatch.id,
      onJournalActivity: () => {}
    }

    try {
      await createStructuredWorkerSession(args)
      db.abandonWorkerDispatch(args.dispatchId)
      releaseStructuredWorkerSession(args.dispatchId)

      await expect(createStructuredWorkerSession(args)).rejects.toMatchObject({
        code: 'dispatch_inactive'
      })
      expect(sessionIdMint).toHaveBeenCalledOnce()
      expect(createSpy).toHaveBeenCalledOnce()
    } finally {
      releaseStructuredWorkerSession(args.dispatchId)
      db.close()
    }
  })

  it('takes a resume-capable hold at start and releases it only on settlement', async () => {
    const { hold, release, dispose } = installHost()
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd1',
      onJournalActivity: () => {}
    })
    // Without the hold, the release clock evicts the provider child 15s after a user closes the
    // worker's chat tab, killing an idle worker mid-dispatch.
    expect(hold).toHaveBeenCalledWith(created.identity.sessionId, structuredWorkerHoldId('d1'))
    expect(createSpy).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()

    releaseStructuredWorkerSession('d1')
    expect(release).toHaveBeenCalledWith(created.identity.sessionId, structuredWorkerHoldId('d1'))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(structuredWorkerIdentities.get(created.identity.handle)).toBeNull()
    // A second settlement is a no-op rather than a second release of the same holder.
    releaseStructuredWorkerSession('d1')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('registers the identity BEFORE the session is created, so the child gets the handle', async () => {
    installHost()
    let envAtSpawn: Record<string, string> | undefined
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      // `attach` is what spawns the provider child, and the child's env is read from the registry
      // at spawn time. Registering afterwards ships a worker with no ORCA_TERMINAL_HANDLE.
      envAtSpawn = structuredWorkerChildIdentityEnv(args.envelope.sessionId, {})
      return { ok: true, value: { sessionId: args.envelope.sessionId } }
    })
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd_spawn',
      onJournalActivity: () => {}
    })
    expect(envAtSpawn?.ORCA_TERMINAL_HANDLE).toBe(created.identity.handle)
    expect(envAtSpawn?.ORCA_CLI_COMMAND).toBe('orca')
    expect(envAtSpawn?.ORCA_PANE_KEY).toBeUndefined()
    releaseStructuredWorkerSession('d_spawn')
  })

  it('exposes the registered identity before one attach and preserves that ordering', async () => {
    installHost()
    const timeline: string[] = []
    const persistAuthority = vi.fn()
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      timeline.push('attach')
      expect(persistAuthority).toHaveBeenCalledOnce()
      return { ok: true, value: { sessionId: args.envelope.sessionId } }
    })
    const beforeAttach = vi.fn(async (identity: StructuredWorkerIdentity) => {
      timeline.push('authority')
      expect(structuredWorkerIdentities.getBySessionId(identity.sessionId)).toBe(identity)
      persistAuthority({
        handle: identity.handle,
        paneKey: identity.paneKey,
        processIncarnation: identity.processIncarnation,
        worktreeId: identity.worktreeId,
        hostScope: identity.hostScope
      })
    })

    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'codex',
      dispatchId: 'd_two_phase',
      beforeAttach,
      onJournalActivity: () => {}
    })

    expect(timeline).toEqual(['authority', 'attach'])
    expect(beforeAttach).toHaveBeenCalledOnce()
    expect(createSpy).toHaveBeenCalledOnce()
    expect(persistAuthority).toHaveBeenCalledWith({
      handle: created.identity.handle,
      paneKey: created.identity.paneKey,
      processIncarnation: created.identity.processIncarnation,
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    releaseStructuredWorkerSession('d_two_phase')
  })

  it('rolls back the reservation without attach or close when pre-attach preparation fails', async () => {
    const { close } = installHost()
    let reservedSessionId = ''
    const beforeAttach = vi.fn(async (identity: StructuredWorkerIdentity) => {
      reservedSessionId = identity.sessionId
      throw new Error('authority preparation failed')
    })

    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        db: startingDb,
        worktreeId: 'wt_1',
        agent: 'codex',
        dispatchId: 'd_pre_attach_fail',
        beforeAttach,
        onJournalActivity: () => {}
      })
    ).rejects.toThrow('authority preparation failed')

    expect(beforeAttach).toHaveBeenCalledOnce()
    expect(createSpy).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(structuredWorkerIdentities.getBySessionId(reservedSessionId)).toBeNull()
  })

  it('cancels and discards an attach that settles while session creation is in flight', async () => {
    const { hold, close } = installHost()
    let finishAttach: (() => void) | undefined
    let sessionId = ''
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      sessionId = args.envelope.sessionId
      await new Promise<void>((resolve) => {
        finishAttach = resolve
      })
      return { ok: true, value: { sessionId } }
    })

    const starting = createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'codex',
      dispatchId: 'd_settled_during_attach',
      onJournalActivity: () => {}
    })
    await vi.waitFor(() => expect(createSpy).toHaveBeenCalledOnce())

    releaseStructuredWorkerSession('d_settled_during_attach')
    finishAttach?.()

    await expect(starting).rejects.toMatchObject({ code: 'dispatch_settled' })
    expect(hold).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledWith(sessionId)
    expect(structuredWorkerIdentities.getBySessionId(sessionId)).toBeNull()
  })

  it('releases a hold acquired concurrently with settlement before discarding the session', async () => {
    const { hold, release, close } = installHost()
    let finishHold: (() => void) | undefined
    hold.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishHold = resolve
        })
    )

    const starting = createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'codex',
      dispatchId: 'd_settled_during_hold',
      onJournalActivity: () => {}
    })
    await vi.waitFor(() => expect(hold).toHaveBeenCalledOnce())
    const sessionId: unknown = createSpy.mock.calls[0]?.[0]?.envelope.sessionId
    if (typeof sessionId !== 'string') {
      throw new Error('session create did not receive a session id')
    }

    releaseStructuredWorkerSession('d_settled_during_hold')
    finishHold?.()

    await expect(starting).rejects.toMatchObject({ code: 'dispatch_settled' })
    expect(release).toHaveBeenCalledWith(sessionId, structuredWorkerHoldId('d_settled_during_hold'))
    expect(close).toHaveBeenCalledWith(sessionId)
    expect(structuredWorkerIdentities.getBySessionId(sessionId)).toBeNull()
  })

  it('forgets the identity and discards the session when the start fails', async () => {
    const { hold } = installHost()
    hold.mockRejectedValueOnce(new Error('hold refused'))
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        db: startingDb,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_fail',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow('hold refused')
    // Neither a live provider child nor a registry entry may outlive the failed start.
    expect(closed).toHaveLength(1)
    expect(structuredWorkerIdentities.getBySessionId(closed[0]!)).toBeNull()
  })

  it('discards the session when the create settled UNKNOWN after attach', async () => {
    installHost()
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    // `commit` answers this after `attach` SUCCEEDED and only the tab publish failed, so the
    // provider child is live. Reading it as "refused, nothing created" strands that child with no
    // hold and no binding, and nothing else in the runtime ever retires it.
    createSpy.mockImplementation(async () => ({
      ok: false,
      refusal: {
        code: 'agent_session_operation_unknown',
        message: 'The chat may have been created, but its tab could not be confirmed.'
      }
    }))
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        db: startingDb,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_unknown',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/was refused/)
    expect(closed).toHaveLength(1)
    expect(structuredWorkerIdentities.getBySessionId(closed[0]!)).toBeNull()
  })

  it('does not close anything when the create refusal proves nothing was created', async () => {
    installHost()
    const closed: string[] = []
    ;(hostRef.current as { close: (id: string) => Promise<void> }).close = async (id) => {
      closed.push(id)
    }
    createSpy.mockImplementation(async () => ({
      ok: false,
      refusal: {
        code: 'structured_agent_session_unsupported',
        message: 'Orca cannot open a structured agent chat for this workspace.'
      }
    }))
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        db: startingDb,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd_definitive',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/was refused/)
    expect(closed).toEqual([])
  })

  it('registers a random handle bound to the created session', async () => {
    installHost()
    const created = await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'codex',
      dispatchId: 'd2',
      onJournalActivity: () => {}
    })
    expect(created.identity.handle.startsWith('structworker_')).toBe(true)
    expect(created.identity.processIncarnation).toBe(`structured:${created.identity.sessionId}`)
    expect(structuredWorkerIdentities.getBySessionId(created.identity.sessionId)?.agent).toBe(
      'codex'
    )
    releaseStructuredWorkerSession('d2')
  })

  it('does not activate the worker session, so a dispatch cannot steal the surface', async () => {
    installHost()
    await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      db: startingDb,
      worktreeId: 'wt_1',
      agent: 'claude',
      dispatchId: 'd3',
      onJournalActivity: () => {}
    })
    expect(createSpy.mock.calls[0]![0].activate).toBe(false)
    releaseStructuredWorkerSession('d3')
  })

  it('refuses a session pinned to a non-local execution host', async () => {
    installHost()
    ;(hostRef.current as { deps: { store: { getRecord: () => unknown } } }).deps.store.getRecord =
      () => ({
        location: { executionHostId: 'ssh-1', wslDistro: null },
        lease: { runtimeFence: 2, runtimeKind: 'native', claimStatus: 'live' }
      })
    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        db: startingDb,
        worktreeId: 'wt_1',
        agent: 'claude',
        dispatchId: 'd4',
        onJournalActivity: () => {}
      })
    ).rejects.toThrow(/local execution host/)
  })
})

describe('structured worker dispatch preamble', () => {
  function hostWithSubmission(submission: Record<string, unknown>) {
    return {
      deps: { store: { getRecord: () => ({ lease: { runtimeFence: 7 } }) } },
      send: async () => ({ ok: true, value: { clientMessageId: 'c1', submission } })
    } as never
  }

  const send = (host: never) =>
    sendStructuredWorkerPreamble({ host, sessionId: 's1', dispatchId: 'd1', preamble: 'spec' })

  it('reports the preamble delivered only on an accepted submission', async () => {
    await expect(
      send(hostWithSubmission({ dispatchState: 'accepted', reason: null }))
    ).resolves.toBeUndefined()
  })

  it('never claims delivery for a submission the provider never acknowledged', async () => {
    // `dispatchSafely` turns ANY thrown adapter call — provider child dead, transport dropped —
    // into `unknown`, and `performSend` still returns ok. Reporting that as `dispatch_input:
    // accepted` marks the worker ready with no task, and the coordinator blocks in
    // `check --wait --types worker_done` until it times out.
    for (const dispatchState of ['unknown', 'pending'] as const) {
      const error = await send(
        hostWithSubmission({ dispatchState, reason: 'provider child exited' })
      ).catch((thrown: unknown) => thrown)
      expect((error as { code?: string }).code).toBe('operation_unknown')
      // The wiring, not just the throw: this is the code that makes the start receipt
      // `outcome_unknown` with the worker-show / worker-abandon recovery commands.
      expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(true)
    }
  })

  it('keeps a rejected preamble a proven failure under a code of its own', async () => {
    const error = await send(
      hostWithSubmission({ dispatchState: 'rejected', reason: 'fence moved' })
    ).catch((thrown: unknown) => thrown)
    // A verdict, not prose. A coordinator must be able to tell "we could not send it"
    // from `operation_unknown`'s "it may be running, go look" without parsing a message,
    // which a bare `Error` forced it to do.
    expect((error as { code?: string }).code).toBe('dispatch_preamble_undelivered')
    expect((error as Error).message).toMatch(/not delivered: fence moved/)
    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(false)
  })

  it('reports a refused transport write as undelivered, never as unknown', async () => {
    // The state a provably-unwritten frame now settles. Nothing reached the provider,
    // so there is no running turn for a coordinator to go and look at.
    const error = await send(
      hostWithSubmission({
        dispatchState: 'rejected',
        reason: dispatchWriteFailureReason(new Error('broken pipe'))
      })
    ).catch((thrown: unknown) => thrown)
    expect((error as { code?: string }).code).toBe('dispatch_preamble_undelivered')
    expect(isUnknownWorkerStartOutcome(error, 'dispatch_input')).toBe(false)
  })
})
