import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCodexLabStructuredLaunchBinding } from '../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import { testCodexLabStructuredLaunchBinding } from '../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'

const hostRef: { current: unknown } = { current: null }
const createSpy = vi.fn()

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: (...args: unknown[]) => createSpy(...args)
}))

const { createStructuredWorkerSession, releaseStructuredWorkerSession } =
  await import('./orchestration-structured-worker-session')
const { structuredWorkerIdentities } = await import('../../structured-worker-identity')

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

describe('structured worker lab binding lifecycle', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    createSpy.mockReset()
  })

  it('registers before attach and removes only when the Dispatch settles', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()
    let sessionId = ''
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      sessionId = args.envelope.sessionId
      expect(getCodexLabStructuredLaunchBinding(sessionId)).toEqual(binding)
      return { ok: true, value: { sessionId } }
    })

    await createStructuredWorkerSession({
      runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
      worktreeId: 'worktree-id',
      agent: 'codex',
      dispatchId: binding.dispatchId,
      labLaunchBinding: binding,
      onJournalActivity: () => {}
    })
    expect(getCodexLabStructuredLaunchBinding(sessionId)).toEqual(binding)

    releaseStructuredWorkerSession(binding.dispatchId)
    expect(getCodexLabStructuredLaunchBinding(sessionId)).toBeUndefined()
  })

  it('removes the binding when attach fails before settlement ownership exists', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()
    let sessionId = ''
    createSpy.mockImplementation(async (args: { envelope: { sessionId: string } }) => {
      sessionId = args.envelope.sessionId
      expect(getCodexLabStructuredLaunchBinding(sessionId)).toEqual(binding)
      throw new Error('attach failed')
    })

    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'worktree-id',
        agent: 'codex',
        dispatchId: binding.dispatchId,
        labLaunchBinding: binding,
        onJournalActivity: () => {}
      })
    ).rejects.toThrow('attach failed')
    expect(getCodexLabStructuredLaunchBinding(sessionId)).toBeUndefined()
  })

  it('refuses a laboratory binding for a non-Codex worker before attach', async () => {
    installHost()
    const binding = testCodexLabStructuredLaunchBinding()

    await expect(
      createStructuredWorkerSession({
        runtime: { ensureStructuredAgentSessionHost: async () => {} } as never,
        worktreeId: 'worktree-id',
        agent: 'claude',
        dispatchId: binding.dispatchId,
        labLaunchBinding: binding,
        onJournalActivity: () => {}
      })
    ).rejects.toMatchObject({
      code: 'ORCA_CODEX_LAB_STRUCTURED_BINDING_REFUSED',
      reason: 'binding_invalid'
    })
    expect(createSpy).not.toHaveBeenCalled()
  })
})
