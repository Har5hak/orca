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
  maxConcurrency: number
): WorkerProfileLeaseBlocker | undefined {
  assertValidCapacity(maxConcurrency)
  const settledPlaceholders = WORKER_SETTLED_STATES.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT worker.dispatch_id,
              worker.state,
              json_extract(worker.start_options, '$.profile.maxConcurrency') AS max_concurrency,
              json_type(worker.start_options, '$.profile.maxConcurrency') AS max_concurrency_type,
              EXISTS (
                SELECT 1
                FROM worker_terminal_resources resource
                WHERE resource.owner_dispatch_id = worker.dispatch_id
                  AND NOT (
                    resource.ownership_state = 'owned'
                    AND resource.release_state = 'not_requested'
                  )
                  AND NOT (
                    resource.ownership_state = 'released'
                    AND resource.release_state = 'released'
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

  const observed = rows.map((row) => {
    const dispatchId = row.dispatch_id
    const state = row.state
    if (typeof dispatchId !== 'string' || typeof state !== 'string') {
      throw new Error('Worker profile lease query returned an invalid row.')
    }
    return { row, dispatchId, state }
  })
  const cleanupPending = observed.find(
    ({ row, state }) =>
      state === 'start_unknown' ||
      state === 'stop_unknown' ||
      WORKER_SETTLED_STATES.some((settledState) => settledState === state) ||
      row.terminal_cleanup_pending === 1
  )
  if (cleanupPending) {
    return { dispatchId: cleanupPending.dispatchId, reason: 'cleanup_pending' }
  }

  const occupied: WorkerProfileLeaseBlocker[] = []
  for (const { row, dispatchId } of observed) {
    const storedCapacity = row.max_concurrency
    if (row.max_concurrency_type !== 'integer' || !isValidCapacity(storedCapacity)) {
      refuse(profileId, 'profile_contract_invalid', 'has an invalid active capacity receipt')
    }
    if (storedCapacity !== maxConcurrency) {
      refuse(profileId, 'profile_contract_invalid', 'has a conflicting active capacity receipt')
    }
    occupied.push({ dispatchId, reason: 'occupied' })
  }
  return occupied.length >= maxConcurrency ? occupied[0] : undefined
}

export function reserveStartingWorkerProfileLease(args: {
  db: Database.Database
  dispatchId: string
  profileId: string
  maxConcurrency: number
  runtimeEpoch: string | null
  startOptions: unknown
}): void {
  assertValidCapacity(args.maxConcurrency)
  const profile = readProfileReceipt(args.startOptions)
  if (profile.id !== args.profileId || profile.maxConcurrency !== args.maxConcurrency) {
    refuse(args.profileId, 'profile_contract_invalid', 'must match the host-authored start receipt')
  }
  const blocker = findWorkerProfileLeaseBlocker(args.db, args.profileId, args.maxConcurrency)
  if (blocker) {
    throw new OrchestrationError(
      'execution_profile_refused',
      blocker.reason === 'cleanup_pending'
        ? `Execution profile ${args.profileId} has unresolved cleanup from Dispatch ${blocker.dispatchId}.`
        : `Execution profile ${args.profileId} has no free capacity; Dispatch ${blocker.dispatchId} holds a slot.`,
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

function readProfileReceipt(value: unknown): { id: unknown; maxConcurrency: unknown } {
  const profile =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'profile') : undefined
  return {
    id: typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'id') : undefined,
    maxConcurrency:
      typeof profile === 'object' && profile !== null
        ? Reflect.get(profile, 'maxConcurrency')
        : undefined
  }
}

function assertValidCapacity(value: unknown): asserts value is number {
  if (!isValidCapacity(value)) {
    throw new OrchestrationError(
      'execution_profile_refused',
      'Execution profile capacity must be a positive safe integer.',
      { reason: 'profile_contract_invalid' }
    )
  }
}

function isValidCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function refuse(profileId: string, reason: string, detail: string): never {
  throw new OrchestrationError(
    'execution_profile_refused',
    `Execution profile ${profileId} ${detail}.`,
    { profileId, reason }
  )
}
