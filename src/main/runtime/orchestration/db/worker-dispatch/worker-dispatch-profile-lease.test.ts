import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

const PROFILE_ID = 'structured-write-v1'
const CAPACITY = 2

function profileStartOptions(maxConcurrency: unknown = CAPACITY): unknown {
  return { profile: { id: PROFILE_ID, maxConcurrency } }
}

describe('worker execution-profile lease', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function start(d: OrchestrationDb, spec: string, maxConcurrency = CAPACITY) {
    return d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: spec,
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(maxConcurrency),
      profileLease: { profileId: PROFILE_ID, maxConcurrency }
    })
  }

  it('reserves two slots before inline Task creation and refuses a third without residue', () => {
    const d = createDb()
    d.db.exec(`
      CREATE TRIGGER require_profile_lease_before_inline_task
      BEFORE INSERT ON tasks
      WHEN NEW.spec LIKE 'profile task%'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
          FROM worker_dispatches
          WHERE json_extract(start_options, '$.profile.id') = '${PROFILE_ID}'
            AND state = 'starting'
        ) THEN RAISE(ABORT, 'profile lease was not reserved before Task creation') END;
      END;
    `)

    const first = start(d, 'profile task one')
    const second = start(d, 'profile task two')
    expect(first.dispatch.id).not.toBe(second.dispatch.id)

    expect(() => start(d, 'profile task refused')).toThrowError(
      expect.objectContaining({
        code: 'execution_profile_refused',
        data: expect.objectContaining({
          reason: 'profile_capacity_exhausted',
          blocker: { dispatchId: expect.stringMatching(/^ctx_/), reason: 'occupied' }
        })
      })
    )
    expect(
      d.db.prepare("SELECT id FROM tasks WHERE spec = 'profile task refused'").get()
    ).toBeUndefined()
    expect(
      d.db
        .prepare(
          "SELECT COUNT(*) AS count FROM worker_dispatches WHERE json_extract(start_options, '$.profile.id') = ?"
        )
        .get(PROFILE_ID)
    ).toEqual({ count: 2 })
  })

  it('keeps cleanup-pending work fenced even when capacity has a free slot', () => {
    const d = createDb()
    const first = start(d, 'cleanup owner')
    d.recordWorkerStage({
      dispatchId: first.dispatch.id,
      stage: 'terminal_created',
      effects: [{ kind: 'terminal', action: 'created', id: 'profile-terminal' }],
      residualResources: [{ kind: 'terminal', id: 'profile-terminal' }]
    })
    d.failWorkerStart(first.dispatch.id, 'terminal_created', 'injected failure')

    expect(() => start(d, 'must stay blocked')).toThrowError(
      expect.objectContaining({
        code: 'execution_profile_refused',
        data: expect.objectContaining({
          reason: 'profile_cleanup_pending',
          blocker: { dispatchId: first.dispatch.id, reason: 'cleanup_pending' }
        })
      })
    )
  })

  it('reports cleanup pending before another active row with an invalid capacity receipt', () => {
    const d = createDb()
    const malformed = start(d, 'malformed active owner')
    const cleanup = start(d, 'cleanup owner behind malformed row')
    d.recordWorkerStage({
      dispatchId: cleanup.dispatch.id,
      stage: 'terminal_created',
      effects: [{ kind: 'terminal', action: 'created', id: 'cleanup-terminal' }],
      residualResources: [{ kind: 'terminal', id: 'cleanup-terminal' }]
    })
    d.failWorkerStart(cleanup.dispatch.id, 'terminal_created', 'injected failure')
    d.db
      .prepare('UPDATE worker_dispatches SET start_options = ? WHERE dispatch_id = ?')
      .run(JSON.stringify(profileStartOptions(1)), malformed.dispatch.id)

    expect(() => start(d, 'cleanup must win')).toThrowError(
      expect.objectContaining({
        code: 'execution_profile_refused',
        data: expect.objectContaining({
          reason: 'profile_cleanup_pending',
          blocker: { dispatchId: cleanup.dispatch.id, reason: 'cleanup_pending' }
        })
      })
    )
  })

  it('refuses malformed or conflicting active capacity receipts', () => {
    const d = createDb()
    start(d, 'capacity two owner')

    expect(() => start(d, 'capacity change', 1)).toThrowError(
      expect.objectContaining({
        code: 'execution_profile_refused',
        data: expect.objectContaining({ reason: 'profile_contract_invalid' })
      })
    )
    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'receipt mismatch',
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(1),
        profileLease: { profileId: PROFILE_ID, maxConcurrency: CAPACITY }
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'execution_profile_refused',
        data: expect.objectContaining({ reason: 'profile_contract_invalid' })
      })
    )
    expect(
      d.db.prepare("SELECT id FROM tasks WHERE spec = 'receipt mismatch'").get()
    ).toBeUndefined()
  })

  it('releases capacity after a cleanly settled start and leaves ordinary starts unchanged', () => {
    const d = createDb()
    const first = start(d, 'clean failure')
    d.failWorkerStart(first.dispatch.id, 'profile_admission', 'clean failure')
    expect(start(d, 'replacement').dispatch.id).not.toBe(first.dispatch.id)

    const ordinary = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'ordinary task',
      taskRunId: 'run_legacy_local',
      startOptions: { worktree: 'current' }
    })
    expect(ordinary.worker).toMatchObject({ state: 'starting', stage: 'accepted' })
  })
})
