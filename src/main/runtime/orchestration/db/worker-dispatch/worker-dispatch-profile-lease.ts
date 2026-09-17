import type Database from '../../../../sqlite/sync-database'
import { OrchestrationError } from '../../orchestration-error'
import { WORKER_SETTLED_STATES } from '../../worker-terminal-ownership'

export type WorkerProfileLeaseBlocker = {
  dispatchId: string
  reason: 'occupied' | 'cleanup_pending'
}

export function findWorkerProfileLeaseBlocker(
  db: Database.Database,
  profileId: string
): WorkerProfileLeaseBlocker | undefined {
  const settledPlaceholders = WORKER_SETTLED_STATES.map(() => '?').join(', ')
  const row = db
    .prepare(
      `SELECT worker.dispatch_id,
              worker.state,
              worker.residual_resources,
              EXISTS (
                SELECT 1
                FROM worker_terminal_resources resource
                WHERE resource.owner_dispatch_id = worker.dispatch_id
                  AND (
                    resource.ownership_state != 'released'
                    OR resource.release_state != 'released'
                  )
              ) AS terminal_cleanup_pending
       FROM worker_dispatches worker
       WHERE json_extract(worker.start_options, '$.profile.id') = ?
         AND (
           worker.state NOT IN (${settledPlaceholders})
           OR CASE
                WHEN json_valid(worker.residual_resources) = 1
                  THEN json_type(worker.residual_resources) != 'array'
                    OR json_array_length(worker.residual_resources) != 0
                ELSE 1
              END
           OR EXISTS (
             SELECT 1
             FROM worker_terminal_resources resource
             WHERE resource.owner_dispatch_id = worker.dispatch_id
               AND (
                 resource.ownership_state != 'released'
                 OR resource.release_state != 'released'
               )
           )
         )
       ORDER BY worker.created_at, worker.dispatch_id
       LIMIT 1`
    )
    .get(profileId, ...WORKER_SETTLED_STATES)
  if (!row) {
    return undefined
  }
  const dispatchId = row.dispatch_id
  const state = row.state
  if (typeof dispatchId !== 'string' || typeof state !== 'string') {
    throw new Error('Worker profile lease query returned an invalid row.')
  }
  const cleanupPending =
    state === 'start_unknown' ||
    state === 'stop_unknown' ||
    WORKER_SETTLED_STATES.some((settledState) => settledState === state) ||
    row.terminal_cleanup_pending === 1
  return {
    dispatchId,
    reason: cleanupPending ? 'cleanup_pending' : 'occupied'
  }
}

export function reserveStartingWorkerProfileLease(args: {
  db: Database.Database
  dispatchId: string
  profileId: string
  runtimeEpoch: string | null
  startOptions: unknown
}): void {
  const profile =
    typeof args.startOptions === 'object' && args.startOptions !== null
      ? Reflect.get(args.startOptions, 'profile')
      : undefined
  const observedProfileId =
    typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'id') : undefined
  if (observedProfileId !== args.profileId) {
    throw new OrchestrationError(
      'lab_profile_refused',
      'The reserved execution profile must match the host-authored start receipt.',
      { profileId: args.profileId, reason: 'profile_contract_invalid' }
    )
  }
  const blocker = findWorkerProfileLeaseBlocker(args.db, args.profileId)
  if (blocker) {
    throw new OrchestrationError(
      'lab_profile_refused',
      blocker.reason === 'cleanup_pending'
        ? `Execution profile ${args.profileId} has unresolved cleanup from Dispatch ${blocker.dispatchId}.`
        : `Execution profile ${args.profileId} is already leased by Dispatch ${blocker.dispatchId}.`,
      {
        profileId: args.profileId,
        reason:
          blocker.reason === 'cleanup_pending'
            ? 'profile_cleanup_pending'
            : 'profile_capacity_exhausted',
        blocker
      }
    )
  }
  args.db
    .prepare(
      `INSERT INTO worker_dispatches (
         dispatch_id, runtime_epoch, state, stage, start_options
       ) VALUES (?, ?, 'starting', 'accepted', ?)`
    )
    .run(args.dispatchId, args.runtimeEpoch, JSON.stringify(args.startOptions))
}
