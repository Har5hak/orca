import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('worker launch profile RPC boundary', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup())
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The worker path reads only handle, worktreeId, and status from this focused runtime seam.
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: 'term_coord',
      worktreeId: 'repo::/repo/worktree',
      status: 'running'
    } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The profile gate reads only this explicit local workspace identity and placement evidence.
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::/repo/worktree',
      repoId: 'repo',
      path: '/repo/worktree',
      hostId: 'local'
    } as never)
    vi.spyOn(runtime, 'createTerminal')
  }

  async function start(params: Record<string, unknown>) {
    return h.call('orchestration.workerStart', params, ctx)
  }

  it('refuses Claude before provider startup, terminal creation, or Dispatch creation', async () => {
    setup()
    const task = db.createTask({ spec: 'disposable Claude canary' })

    await expect(
      start({
        task: task.id,
        from: 'term_coord',
        agent: 'claude',
        launchProfile: 'lab-subscription-no-mcp-v1'
      })
    ).rejects.toMatchObject({
      code: 'launch_profile_external_isolation_required',
      data: {
        launchProfile: {
          id: 'lab-subscription-no-mcp-v1',
          version: 1,
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        },
        containment: 'provider_capabilities_only',
        blocker: 'external_isolation_required',
        filesystemContainment: false,
        networkContainment: false,
        hostContainment: false,
        productionSafe: false
      }
    })

    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('does not create an inline Task when the isolation gate refuses', async () => {
    setup()
    const taskIdsBefore = db.listTasks().map((task) => task.id)

    await expect(
      start({
        spec: 'inline disposable Claude canary',
        from: 'term_coord',
        agent: 'claude',
        launchProfile: 'lab-subscription-no-mcp-v1'
      })
    ).rejects.toMatchObject({ code: 'launch_profile_external_isolation_required' })

    expect(db.listTasks().map((task) => task.id)).toEqual(taskIdsBefore)
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('keeps the more specific Codex isolated-home refusal with no effects', async () => {
    setup()
    const task = db.createTask({ spec: 'Codex needs an isolated home first' })

    await expect(
      start({
        task: task.id,
        from: 'term_coord',
        agent: 'codex',
        launchProfile: 'lab-subscription-no-mcp-v1'
      })
    ).rejects.toMatchObject({ code: 'codex_isolated_home_required' })

    expect(runtime.showManagedTerminalWorkspace).not.toHaveBeenCalled()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })
})
