import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

const CREATED_LAB_RUNTIME_KIND = 'created_lab_runtime'

describe('worker Dispatch authority residual custody', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function createStartingDispatch(d: OrchestrationDb) {
    return d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'lab authority residual custody',
      taskRunId: 'run_legacy_local',
      startOptions: { profile: { id: 'lab-readonly-supervised-v1' } }
    })
  }

  function attachAuthority(
    d: OrchestrationDb,
    dispatchId: string,
    preserveCreatedLabRuntimeResidual = true
  ): string {
    return d.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_lab_worker',
      paneKey: 'tab_lab_worker:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'runtime:pty:lab-worker',
      worktreeId: 'repo::lab-worker',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_lab_worker' }],
      ...(preserveCreatedLabRuntimeResidual
        ? { preserveCreatedLabRuntimeResidual: true as const }
        : {}),
      terminalOwnership: 'created'
    })
  }

  function authorityState(d: OrchestrationDb, dispatchId: string) {
    return {
      dispatch: d.db.prepare('SELECT * FROM dispatch_contexts WHERE id = ?').get(dispatchId),
      worker: d.db.prepare('SELECT * FROM worker_dispatches WHERE dispatch_id = ?').get(dispatchId),
      terminalResource: d.getWorkerTerminalResourceByOwner(dispatchId)
    }
  }

  it('preserves the exact dispatch-bound lab runtime residual while attaching authority', () => {
    const d = createDb()
    const started = createStartingDispatch(d)
    const labRuntimeResidual = {
      kind: CREATED_LAB_RUNTIME_KIND,
      id: started.dispatch.id
    }
    d.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'lab_runtime_planned',
      effects: [labRuntimeResidual],
      residualResources: [labRuntimeResidual]
    })
    const residualBefore = d.getWorkerDispatch(started.dispatch.id)?.residual_resources

    expect(attachAuthority(d, started.dispatch.id)).toMatch(/^dcap_/)

    const worker = d.getWorkerDispatch(started.dispatch.id)
    expect(worker).toMatchObject({ stage: 'authority_attached' })
    expect(worker?.residual_resources).toBe(residualBefore)
    expect(JSON.parse(String(worker?.residual_resources))).toEqual([labRuntimeResidual])
  })

  it('rejects a residual bound to another Dispatch without a partial authority mutation', () => {
    const d = createDb()
    const started = createStartingDispatch(d)
    d.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'lab_runtime_planned',
      residualResources: [{ kind: CREATED_LAB_RUNTIME_KIND, id: 'ctx_another_lab_dispatch' }]
    })
    const before = authorityState(d, started.dispatch.id)

    expect(() => attachAuthority(d, started.dispatch.id)).toThrowError(
      expect.objectContaining({ code: 'request_mismatch' })
    )

    expect(authorityState(d, started.dispatch.id)).toEqual(before)
  })

  it.each([
    [
      'an array-shaped id',
      (dispatchId: string) => [{ kind: CREATED_LAB_RUNTIME_KIND, id: [dispatchId] }]
    ],
    [
      'an extra action field',
      (dispatchId: string) => [
        { kind: CREATED_LAB_RUNTIME_KIND, id: dispatchId, action: 'created' }
      ]
    ],
    [
      'a non-array envelope',
      (dispatchId: string) => ({ kind: CREATED_LAB_RUNTIME_KIND, id: dispatchId })
    ]
  ])('rejects %s without a partial authority mutation', (_label, makeResidual) => {
    const d = createDb()
    const started = createStartingDispatch(d)
    d.db
      .prepare('UPDATE worker_dispatches SET residual_resources = ? WHERE dispatch_id = ?')
      .run(JSON.stringify(makeResidual(started.dispatch.id)), started.dispatch.id)
    const before = authorityState(d, started.dispatch.id)

    expect(() => attachAuthority(d, started.dispatch.id)).toThrowError(
      expect.objectContaining({ code: 'request_mismatch' })
    )

    expect(authorityState(d, started.dispatch.id)).toEqual(before)
  })

  it('keeps ordinary authority attachment on the existing effect-derived residual path', () => {
    const d = createDb()
    const started = createStartingDispatch(d)
    const staleResidual = { kind: CREATED_LAB_RUNTIME_KIND, id: started.dispatch.id }
    d.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'ordinary_start_progress',
      residualResources: [staleResidual]
    })

    attachAuthority(d, started.dispatch.id, false)

    expect(
      JSON.parse(String(d.getWorkerDispatch(started.dispatch.id)?.residual_resources))
    ).toEqual([{ kind: 'terminal', action: 'created', id: 'term_lab_worker' }])
  })
})
