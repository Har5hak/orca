import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

const PROFILE_ID = 'lab-readonly-supervised-v1'

function profileStartOptions(maxConcurrency: unknown = 1): unknown {
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

  it('reserves the profile before creating an inline Task', () => {
    const d = createDb()
    d.db.exec(`
      CREATE TRIGGER require_profile_lease_before_inline_task
      BEFORE INSERT ON tasks
      WHEN NEW.spec = 'profile inline task'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1
          FROM worker_dispatches
          WHERE json_extract(start_options, '$.profile.id') = '${PROFILE_ID}'
            AND state = 'starting'
        ) THEN RAISE(ABORT, 'profile lease was not reserved before Task creation') END;
      END;
    `)

    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'profile inline task',
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(),
      profileLease: { profileId: PROFILE_ID }
    })

    expect(started.task.spec).toBe('profile inline task')
    expect(started.worker).toMatchObject({ state: 'starting', stage: 'accepted' })
  })

  it('refuses a competing start without leaving a Task, worker or mutation receipt', () => {
    const d = createDb()
    const winner = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'winning profile task',
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(),
      profileLease: { profileId: PROFILE_ID }
    })

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'losing profile task',
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(),
        profileLease: { profileId: PROFILE_ID },
        mutationReceipt: {
          callerFingerprint: 'profile_race_loser',
          requestId: 'profile_race_loser_request',
          method: 'orchestration.workerStart',
          payloadHash: 'profile_race_loser_hash'
        }
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'lab_profile_refused',
        data: expect.objectContaining({
          reason: 'profile_capacity_exhausted',
          blocker: { dispatchId: winner.dispatch.id, reason: 'occupied' }
        })
      })
    )
    expect(
      d.db.prepare("SELECT id FROM tasks WHERE spec = 'losing profile task'").get()
    ).toBeUndefined()
    expect(d.getMutationReceipt('profile_race_loser', 'profile_race_loser_request')).toBeUndefined()
    expect(
      d.db
        .prepare(
          "SELECT COUNT(*) AS count FROM worker_dispatches WHERE json_extract(start_options, '$.profile.id') = ?"
        )
        .get(PROFILE_ID)
    ).toEqual({ count: 1 })
  })

  it('atomically admits two capacity-two starts and refuses the third without residue', () => {
    const d = createDb()
    const start = (spec: string) =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: spec,
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(2),
        profileLease: { profileId: PROFILE_ID }
      })

    const first = start('capacity two first')
    const second = start('capacity two second')
    expect(first.dispatch.id).not.toBe(second.dispatch.id)
    expect(
      d.db
        .prepare(
          "SELECT COUNT(*) AS count FROM worker_dispatches WHERE json_extract(start_options, '$.profile.id') = ?"
        )
        .get(PROFILE_ID)
    ).toEqual({ count: 2 })

    expect(() => start('capacity two refused third')).toThrowError(
      expect.objectContaining({
        code: 'lab_profile_refused',
        data: expect.objectContaining({
          reason: 'profile_capacity_exhausted',
          blocker: {
            dispatchId: expect.stringMatching(/^ctx_/),
            reason: 'occupied'
          }
        })
      })
    )
    expect(
      d.db.prepare("SELECT id FROM tasks WHERE spec = 'capacity two refused third'").get()
    ).toBeUndefined()
    expect(
      d.db
        .prepare(
          "SELECT COUNT(*) AS count FROM worker_dispatches WHERE json_extract(start_options, '$.profile.id') = ?"
        )
        .get(PROFILE_ID)
    ).toEqual({ count: 2 })
  })

  it('fails closed on cleanup pending even when bounded capacity has a free slot', () => {
    const d = createDb()
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'capacity two cleanup owner',
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(2),
      profileLease: { profileId: PROFILE_ID }
    })
    d.recordWorkerStage({
      dispatchId: first.dispatch.id,
      stage: 'profile_terminal_created',
      effects: [{ kind: 'terminal', action: 'created', id: 'profile-terminal' }],
      residualResources: [{ kind: 'terminal', id: 'profile-terminal' }]
    })
    d.failWorkerStart(first.dispatch.id, 'profile_terminal_created', 'injected failure')

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'must not consume free capacity during cleanup',
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(2),
        profileLease: { profileId: PROFILE_ID }
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'lab_profile_refused',
        data: expect.objectContaining({
          reason: 'profile_cleanup_pending',
          blocker: { dispatchId: first.dispatch.id, reason: 'cleanup_pending' }
        })
      })
    )
  })

  it('refuses a capacity change while the same profile has an active lease', () => {
    const d = createDb()
    d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'capacity one owner',
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(1),
      profileLease: { profileId: PROFILE_ID }
    })

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'capacity broadening attempt',
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(2),
        profileLease: { profileId: PROFILE_ID }
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'lab_profile_refused',
        data: expect.objectContaining({ reason: 'profile_contract_invalid' })
      })
    )
    expect(
      d.db.prepare("SELECT id FROM tasks WHERE spec = 'capacity broadening attempt'").get()
    ).toBeUndefined()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '2', true])(
    'rejects invalid host-authored capacity %s before lifecycle rows are written',
    (maxConcurrency) => {
      const d = createDb()
      expect(() =>
        d.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskSpec: 'invalid capacity task',
          taskRunId: 'run_legacy_local',
          startOptions: profileStartOptions(maxConcurrency),
          profileLease: { profileId: PROFILE_ID }
        })
      ).toThrowError(
        expect.objectContaining({
          code: 'lab_profile_refused',
          data: expect.objectContaining({ reason: 'profile_contract_invalid' })
        })
      )
      expect(d.db.prepare('SELECT COUNT(*) AS count FROM worker_dispatches').get()).toEqual({
        count: 0
      })
      expect(d.db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
    }
  )

  it('treats only a genuinely missing stored capacity as the legacy capacity one contract', () => {
    const d = createDb()
    d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'legacy capacity owner',
      taskRunId: 'run_legacy_local',
      startOptions: { profile: { id: PROFILE_ID } },
      profileLease: { profileId: PROFILE_ID }
    })

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'legacy capacity competitor',
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(1),
        profileLease: { profileId: PROFILE_ID }
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'lab_profile_refused',
        data: expect.objectContaining({ reason: 'profile_capacity_exhausted' })
      })
    )
  })

  it.each([null, '2', true])(
    'rejects invalid stored capacity %s instead of treating it as a legacy omission',
    (maxConcurrency) => {
      const d = createDb()
      d.db
        .prepare(
          `INSERT INTO worker_dispatches (
             dispatch_id, runtime_epoch, state, stage, start_options
           ) VALUES (?, NULL, 'starting', 'accepted', ?)`
        )
        .run(
          `ctx_invalid_stored_${String(maxConcurrency)}`,
          JSON.stringify({ profile: { id: PROFILE_ID, maxConcurrency } })
        )

      expect(() =>
        d.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskSpec: 'stored invalid capacity competitor',
          taskRunId: 'run_legacy_local',
          startOptions: profileStartOptions(1),
          profileLease: { profileId: PROFILE_ID }
        })
      ).toThrowError(
        expect.objectContaining({
          code: 'lab_profile_refused',
          data: expect.objectContaining({ reason: 'profile_contract_invalid' })
        })
      )
    }
  )

  it('keeps failed profile cleanup fenced until residual resources are reconciled', () => {
    const d = createDb()
    const winner = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'profile cleanup owner',
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(),
      profileLease: { profileId: PROFILE_ID }
    })
    d.recordWorkerStage({
      dispatchId: winner.dispatch.id,
      stage: 'profile_terminal_created',
      effects: [{ kind: 'terminal', action: 'created', id: 'profile-terminal' }],
      residualResources: [{ kind: 'terminal', id: 'profile-terminal' }]
    })
    d.failWorkerStart(winner.dispatch.id, 'profile_terminal_created', 'injected failure')

    expect(() =>
      d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'must stay blocked',
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(),
        profileLease: { profileId: PROFILE_ID }
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'lab_profile_refused',
        data: expect.objectContaining({
          reason: 'profile_cleanup_pending',
          blocker: { dispatchId: winner.dispatch.id, reason: 'cleanup_pending' }
        })
      })
    )
  })

  it('releases capacity after a clean failed start', () => {
    const d = createDb()
    const first = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'cleanly failed profile task',
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(),
      profileLease: { profileId: PROFILE_ID }
    })
    d.failWorkerStart(first.dispatch.id, 'profile_admission', 'clean failure')

    const second = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'next profile task',
      taskRunId: 'run_legacy_local',
      startOptions: profileStartOptions(),
      profileLease: { profileId: PROFILE_ID }
    })
    expect(second.dispatch.id).not.toBe(first.dispatch.id)
  })

  it.each(['{}', 'null', '"residual"', '1', 'not-json'])(
    'fails closed when settled residual resource metadata has non-clean shape %s',
    (residualResources) => {
      const d = createDb()
      const first = d.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'settled profile with malformed residue',
        taskRunId: 'run_legacy_local',
        startOptions: profileStartOptions(),
        profileLease: { profileId: PROFILE_ID }
      })
      d.failWorkerStart(first.dispatch.id, 'profile_cleanup', 'injected failure')
      d.db
        .prepare('UPDATE worker_dispatches SET residual_resources = ? WHERE dispatch_id = ?')
        .run(residualResources, first.dispatch.id)

      expect(() =>
        d.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskSpec: 'must remain fenced by malformed residue',
          taskRunId: 'run_legacy_local',
          startOptions: profileStartOptions(),
          profileLease: { profileId: PROFILE_ID }
        })
      ).toThrowError(
        expect.objectContaining({
          code: 'lab_profile_refused',
          data: expect.objectContaining({
            reason: 'profile_cleanup_pending',
            blocker: { dispatchId: first.dispatch.id, reason: 'cleanup_pending' }
          })
        })
      )
    }
  )
})
