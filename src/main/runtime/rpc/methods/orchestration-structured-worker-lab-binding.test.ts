import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as publicBindingRegistry from '../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import { testCodexLabStructuredLaunchBinding } from '../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import { OrcaRuntimeService } from '../../orca-runtime'

const { getCodexLabStructuredLaunchBinding } = publicBindingRegistry

const hostRef: { current: unknown } = { current: null }
const createSpy = vi.fn()
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session creation reads only these two lifecycle queries, and this fixture returns their exact starting-state fields.
const startingDb = {
  getDispatchContextById: () => ({ status: 'pending' }),
  getWorkerDispatch: () => ({ state: 'starting' })
} as never

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createSpy(...args)
}))

const { createStructuredWorkerSession, releaseStructuredWorkerSession } =
  await import('./orchestration-structured-worker-session')
const { structuredWorkerIdentities } = await import('../../structured-worker-identity')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these adversarial tests intentionally exercise runtime rejection of caller shapes excluded by the TypeScript union.
const createStructuredWorkerSessionUnchecked = createStructuredWorkerSession as (
  args: object
) => ReturnType<typeof createStructuredWorkerSession>

function installHost() {
  const release = vi.fn()
  hostRef.current = {
    deps: {
      store: {
        getRecord: () => ({
          location: { executionHostId: 'local', wslDistro: null },
          lease: { runtimeFence: 1 }
        })
      }
    },
    hold: vi.fn(async () => {}),
    release,
    subscribe: () => () => {},
    close: vi.fn(async () => {}),
    setSessionTabVisibility: vi.fn(async () => {})
  }
  return { release }
}

function publicBinding(binding: ReturnType<typeof testCodexLabStructuredLaunchBinding>) {
  return {
    dispatchId: binding.dispatchId,
    plan: binding.plan,
    worktree: binding.worktree
  }
}

describe('structured worker lab binding lifecycle', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    createSpy.mockReset()
  })

  it('keeps the public registry surface read-only', () => {
    expect(publicBindingRegistry).not.toHaveProperty('registerCodexLabStructuredLaunchBinding')
    expect(publicBindingRegistry).not.toHaveProperty('releaseCodexLabStructuredLaunchBinding')
  })

  it('registers before attach and removes only when the Dispatch settles', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()
    let sessionId = ''
    let reservedSessionId = ''
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      sessionId = args.envelope.sessionId
      expect(sessionId).toBe(reservedSessionId)
      expect(getCodexLabStructuredLaunchBinding(sessionId)).toEqual(publicBinding(binding))
      expect(getCodexLabStructuredLaunchBinding(sessionId)).not.toHaveProperty(
        'labDynamicToolHostFactory'
      )
      return { ok: true, value: { sessionId } }
    })

    await createStructuredWorkerSession({
      runtime: new OrcaRuntimeService(),
      db: startingDb,
      worktreeId: 'worktree-id',
      agent: 'codex',
      dispatchId: binding.dispatchId,
      launchMode: 'codex-lab',
      beforeAttach: async (identity) => {
        reservedSessionId = identity.sessionId
        expect(getCodexLabStructuredLaunchBinding(identity.sessionId)).toBeUndefined()
        return { labLaunchBinding: binding }
      },
      onJournalActivity: () => {}
    })
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ accountHomePathOverride: binding.plan.runtimePaths.codexHome })
    )
    expect(getCodexLabStructuredLaunchBinding(sessionId)).toEqual(publicBinding(binding))

    releaseStructuredWorkerSession(binding.dispatchId)
    expect(getCodexLabStructuredLaunchBinding(sessionId)).toBeUndefined()
  })

  it('removes the binding when attach fails before settlement ownership exists', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()
    let sessionId = ''
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      sessionId = args.envelope.sessionId
      expect(getCodexLabStructuredLaunchBinding(sessionId)).toEqual(publicBinding(binding))
      throw new Error('attach failed')
    })

    await expect(
      createStructuredWorkerSession({
        runtime: new OrcaRuntimeService(),
        db: startingDb,
        worktreeId: 'worktree-id',
        agent: 'codex',
        dispatchId: binding.dispatchId,
        launchMode: 'codex-lab',
        beforeAttach: async () => ({ labLaunchBinding: binding }),
        onJournalActivity: () => {}
      })
    ).rejects.toThrow('attach failed')
    expect(getCodexLabStructuredLaunchBinding(sessionId)).toBeUndefined()
  })

  it('refuses the removed direct binding input without reserving or attaching a session', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()
    const staleCallerArgs = {
      runtime: new OrcaRuntimeService(),
      db: startingDb,
      worktreeId: 'worktree-id',
      agent: 'codex',
      dispatchId: binding.dispatchId,
      labLaunchBinding: binding,
      onJournalActivity: () => {}
    }

    await expect(createStructuredWorkerSessionUnchecked(staleCallerArgs)).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_STRUCTURED_BINDING_REFUSED',
      reason: 'binding_invalid'
    })
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('refuses an unknown launch mode before identity reservation or attach', async () => {
    installHost()
    const registerIdentity = vi.spyOn(structuredWorkerIdentities, 'register')
    const staleCallerArgs = {
      runtime: new OrcaRuntimeService(),
      db: startingDb,
      worktreeId: 'worktree-id',
      agent: 'codex',
      dispatchId: 'dispatch-unknown-launch-mode',
      launchMode: 'legacy-lab',
      onJournalActivity: () => {}
    }

    try {
      await expect(createStructuredWorkerSessionUnchecked(staleCallerArgs)).rejects.toMatchObject({
        code: 'worker_launch_mode_invalid'
      })
      expect(registerIdentity).not.toHaveBeenCalled()
      expect(createSpy).not.toHaveBeenCalled()
    } finally {
      registerIdentity.mockRestore()
    }
  })

  it('fails closed before attach when explicit lab preparation returns no binding', async () => {
    installHost()
    let reservedSessionId = ''
    const buggyLabArgs = {
      runtime: new OrcaRuntimeService(),
      db: startingDb,
      worktreeId: 'worktree-id',
      agent: 'codex',
      dispatchId: 'dispatch-missing-binding',
      launchMode: 'codex-lab',
      beforeAttach: async (identity: { sessionId: string }) => {
        reservedSessionId = identity.sessionId
      },
      onJournalActivity: () => {}
    }

    await expect(createStructuredWorkerSessionUnchecked(buggyLabArgs)).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_STRUCTURED_BINDING_REFUSED',
      reason: 'binding_missing'
    })
    expect(createSpy).not.toHaveBeenCalled()
    expect(structuredWorkerIdentities.getBySessionId(reservedSessionId)).toBeNull()
  })

  it('does not infer lab mode when an ordinary callback returns a binding', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()
    const accidentalLabArgs = {
      runtime: new OrcaRuntimeService(),
      db: startingDb,
      worktreeId: 'worktree-id',
      agent: 'codex',
      dispatchId: binding.dispatchId,
      beforeAttach: async () => ({ labLaunchBinding: binding }),
      onJournalActivity: () => {}
    }

    await expect(createStructuredWorkerSessionUnchecked(accidentalLabArgs)).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_STRUCTURED_BINDING_REFUSED',
      reason: 'binding_invalid'
    })
    expect(createSpy).not.toHaveBeenCalled()
  })

  it('refuses a non-Codex lab mode before callback, identity, reservation, or attach', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()
    const beforeAttach = vi.fn(async () => ({ labLaunchBinding: binding }))
    const registerIdentity = vi.spyOn(structuredWorkerIdentities, 'register')

    try {
      await expect(
        createStructuredWorkerSessionUnchecked({
          runtime: new OrcaRuntimeService(),
          db: startingDb,
          worktreeId: 'worktree-id',
          agent: 'claude',
          dispatchId: binding.dispatchId,
          launchMode: 'codex-lab',
          beforeAttach,
          onJournalActivity: () => {}
        })
      ).rejects.toMatchObject({
        code: 'ORCA_CODEX_LAB_STRUCTURED_BINDING_REFUSED',
        reason: 'agent_mode_mismatch'
      })
      expect(beforeAttach).not.toHaveBeenCalled()
      expect(registerIdentity).not.toHaveBeenCalled()
      expect(createSpy).not.toHaveBeenCalled()
    } finally {
      registerIdentity.mockRestore()
    }

    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => ({
      ok: true,
      value: { sessionId: args.envelope.sessionId }
    }))
    const retried = await createStructuredWorkerSession({
      runtime: new OrcaRuntimeService(),
      db: startingDb,
      worktreeId: 'worktree-id',
      agent: 'codex',
      dispatchId: binding.dispatchId,
      launchMode: 'codex-lab',
      beforeAttach: async () => ({ labLaunchBinding: binding }),
      onJournalActivity: () => {}
    })
    releaseStructuredWorkerSession(binding.dispatchId)
    expect(retried.identity.agent).toBe('codex')
  })
})
