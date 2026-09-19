import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { expectedCodexLabDispatchRuntimeRoot } from '../lab-runtime-custody/lab-runtime-custody-validation'

const PANE_KEY = 'tab_lab_worker:11111111-1111-4111-8111-111111111111'
const PROCESS_INCARNATION = 'runtime:pty:lab-worker'

describe('worker terminal transfer custody', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('refuses to transfer a settled terminal while Codex laboratory custody is unreleased', () => {
    const d = (db = new OrchestrationDb(':memory:'))
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'legacy laboratory worker',
      taskRunId: 'run_legacy_local',
      startOptions: {}
    })
    d.prepareStartingWorkerAuthority({
      dispatchId: first.dispatch.id,
      handle: 'term_lab_worker',
      paneKey: PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::lab-worker',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    d.markWorkerDispatchReady(first.dispatch.id)
    d.settleWorkerReport({
      taskId: first.task.id,
      dispatchId: first.dispatch.id,
      outcome: 'succeeded',
      result: '{}'
    })
    d.db
      .prepare(
        `INSERT INTO codex_lab_runtime_custody (
           dispatch_id, profile_id, state, runtime_root
         ) VALUES (?, 'lab-readonly-supervised-v1', 'planned', ?)`
      )
      .run(first.dispatch.id, expectedCodexLabDispatchRuntimeRoot(first.dispatch.id))

    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'must not reuse laboratory custody',
      taskRunId: 'run_legacy_local',
      startOptions: {}
    })
    const original = d.getWorkerTerminalResourceByOwner(first.dispatch.id)

    expect(() =>
      d.prepareStartingWorkerAuthority({
        dispatchId: second.dispatch.id,
        handle: 'term_lab_worker',
        paneKey: PANE_KEY,
        processIncarnation: PROCESS_INCARNATION,
        worktreeId: 'repo::next-worker',
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'external'
      })
    ).toThrowError(expect.objectContaining({ code: 'terminal_release_in_progress' }))

    expect(d.getWorkerTerminalResourceByOwner(first.dispatch.id)).toEqual(original)
    expect(d.getWorkerTerminalResourceByOwner(second.dispatch.id)).toBeUndefined()
    expect(d.getWorkerDispatch(second.dispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'accepted'
    })
  })
})
