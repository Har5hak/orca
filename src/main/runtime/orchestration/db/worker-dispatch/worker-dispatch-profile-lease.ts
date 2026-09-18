import type Database from '../../../../sqlite/sync-database'
import { OrchestrationError } from '../../orchestration-error'
import { WORKER_SETTLED_STATES } from '../../worker-terminal-ownership'

export type WorkerProfileLeaseBlocker = {
  dispatchId: string
  reason: 'occupied' | 'cleanup_pending'
}

export function findWorkerProfileLeaseBlocker(
  db: Database.Database,
  profileId: string,
  maxConcurrency = 1
): WorkerProfileLeaseBlocker | undefined {
  if (!isValidCapacity(maxConcurrency)) {
    throw new Error('Worker profile lease capacity must be a positive safe integer.')
  }
  const settledPlaceholders = WORKER_SETTLED_STATES.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT worker.dispatch_id,
              worker.state,
              json_extract(worker.start_options, '$.profile.maxConcurrency') AS max_concurrency,
              json_type(worker.start_options, '$.profile.maxConcurrency') AS max_concurrency_type,
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
       ORDER BY worker.created_at, worker.dispatch_id`
    )
    .all(profileId, ...WORKER_SETTLED_STATES)
  if (rows.length === 0) {
    return undefined
  }
  const occupied: WorkerProfileLeaseBlocker[] = []
  for (const row of rows) {
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
    if (cleanupPending) {
      return { dispatchId, reason: 'cleanup_pending' }
    }
    const storedCapacity = row.max_concurrency_type === null ? 1 : row.max_concurrency
    if (
      (row.max_concurrency_type !== null && row.max_concurrency_type !== 'integer') ||
      !isValidCapacity(storedCapacity) ||
      storedCapacity !== maxConcurrency
    ) {
      throw new OrchestrationError(
        'lab_profile_refused',
        `Execution profile ${profileId} has a conflicting active capacity receipt.`,
        { profileId, reason: 'profile_contract_invalid' }
      )
    }
    occupied.push({ dispatchId, reason: 'occupied' })
  }
  return occupied.length >= maxConcurrency ? occupied[0] : undefined
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
  const observedMaxConcurrency =
    typeof profile === 'object' && profile !== null
      ? Reflect.has(profile, 'maxConcurrency')
        ? Reflect.get(profile, 'maxConcurrency')
        : 1
      : undefined
  if (observedProfileId !== args.profileId || !isValidCapacity(observedMaxConcurrency)) {
    throw new OrchestrationError(
      'lab_profile_refused',
      'The reserved execution profile must match the host-authored start receipt.',
      { profileId: args.profileId, reason: 'profile_contract_invalid' }
    )
  }
  const blocker = findWorkerProfileLeaseBlocker(args.db, args.profileId, observedMaxConcurrency)
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

function isValidCapacity(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}
