import type Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type {
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyIdentity,
  CodexLabRuntimeCustodyState
} from './lab-runtime-custody-contract'
import { requireCustody, requireCustodyIdentity } from './lab-runtime-custody-row'
import { requireCodexLabCustodyIdentityParts } from './lab-runtime-custody-validation'

export type AdvanceCustodyOptions = Readonly<{
  identity: CodexLabRuntimeCustodyIdentity
  from: CodexLabRuntimeCustodyState
  to: CodexLabRuntimeCustodyState
  assignments?: string
  values?: readonly Database.BindValue[]
  evidenceMatches?: (row: CodexLabRuntimeCustody) => boolean
}>

export function advanceCustody(
  db: OrchestrationDb,
  options: AdvanceCustodyOptions
): CodexLabRuntimeCustody {
  requireCodexLabCustodyIdentityParts(options.identity.dispatchId, options.identity.profileId)
  return runLifecycleWriteTransaction(db.db, 'advance_codex_lab_runtime_custody', () => {
    const current = requireCustodyIdentity(db, options.identity)
    if (current.state === options.to) {
      if (options.evidenceMatches && !options.evidenceMatches(current)) {
        throw new Error('Codex laboratory runtime transition was replayed with different evidence.')
      }
      requireActiveAggregateCustody(db, options.identity)
      return current
    }
    if (current.state !== options.from) {
      throwStateRefusal(options.identity.dispatchId, options.from, current.state)
    }
    requireActiveAggregateCustody(db, options.identity)
    const assignments = options.assignments ? `, ${options.assignments}` : ''
    const changed = db.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET state = ?, revision = revision + 1, updated_at = datetime('now')${assignments}
         WHERE dispatch_id = ? AND profile_id = ? AND state = ?`
      )
      .run(
        options.to,
        ...(options.values ?? []),
        options.identity.dispatchId,
        options.identity.profileId,
        options.from
      )
    if (changed.changes !== 1) {
      throw new Error('Codex laboratory runtime transition lost its state comparison.')
    }
    return requireCustody(db, options.identity.dispatchId)
  })
}

export function requireAggregateCustody(
  db: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): string {
  const dispatch = db.getDispatchContextById(identity.dispatchId)
  const worker = db.getWorkerDispatch(identity.dispatchId)
  if (
    !dispatch ||
    !worker ||
    profileIdFromStartOptions(worker.start_options) !== identity.profileId
  ) {
    throw new Error('Codex laboratory runtime custody does not match a durable worker Dispatch.')
  }
  const expected = JSON.stringify([{ kind: 'created_lab_runtime', id: identity.dispatchId }])
  if (worker.residual_resources !== expected) {
    throw new Error('Codex laboratory runtime aggregate cleanup receipt is missing or malformed.')
  }
  return expected
}

export function requireActiveAggregateCustody(
  db: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): string {
  const residual = requireAggregateCustody(db, identity)
  const dispatch = db.getDispatchContextById(identity.dispatchId)
  const worker = db.getWorkerDispatch(identity.dispatchId)
  if (dispatch?.status !== 'pending' || worker?.state !== 'starting') {
    throw new Error('Codex laboratory runtime launch custody is no longer active.')
  }
  return residual
}

export function requireReleasedAggregate(
  db: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): void {
  const worker = db.getWorkerDispatch(identity.dispatchId)
  if (
    !worker ||
    worker.residual_resources !== '[]' ||
    profileIdFromStartOptions(worker.start_options) !== identity.profileId
  ) {
    throw new Error('Released Codex laboratory runtime still holds aggregate cleanup custody.')
  }
}

export function throwStateRefusal(
  dispatchId: string,
  expected: CodexLabRuntimeCustodyState,
  actual: CodexLabRuntimeCustodyState
): never {
  throw new Error(
    `Codex laboratory runtime custody for Dispatch ${dispatchId} expected ${expected}, not ${actual}.`
  )
}

function profileIdFromStartOptions(serialized: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined
  }
  const profile = Reflect.get(parsed, 'profile')
  if (!profile || typeof profile !== 'object') {
    return undefined
  }
  const id = Reflect.get(profile, 'id')
  return typeof id === 'string' ? id : undefined
}
