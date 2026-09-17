import type { DispatchContextRow, WorkerDispatchRow } from '../types'
import type { LabGatewayCanonicalLifecycle } from './dispatch-gateway-server'

const ACTIVE_WORKER_STATES = new Set<WorkerDispatchRow['state']>(['starting', 'ready'])
const ACTIVE_DISPATCH_STATES = new Set<DispatchContextRow['status']>(['pending', 'dispatched'])

type LabGatewayLifecycleStore = Readonly<{
  getDispatchContextById: (dispatchId: string) => DispatchContextRow | undefined
  getWorkerDispatch: (dispatchId: string) => WorkerDispatchRow | undefined
}>

export type LabGatewayLifecycleResolverInput = Readonly<{
  db: LabGatewayLifecycleStore
  runtimeEpoch: string
  profileId: string
}>

/**
 * Re-derives gateway authority from Orca's durable lifecycle on every call.
 * No socket-local state can keep a revoked, settled or foreign-runtime worker alive.
 */
export function createLabGatewayLifecycleResolver(
  input: LabGatewayLifecycleResolverInput
): (dispatchId: string) => Promise<LabGatewayCanonicalLifecycle | null> {
  if (!input.runtimeEpoch.trim() || !input.profileId.trim()) {
    throw new Error('Laboratory gateway lifecycle identity must be non-empty')
  }
  return async (dispatchId) => {
    const dispatch = input.db.getDispatchContextById(dispatchId)
    const worker = input.db.getWorkerDispatch(dispatchId)
    if (!dispatch || !worker || !hasBoundIdentity(dispatch) || !dispatch.capability_hash) {
      return null
    }

    const workerIdentityMatches =
      worker.dispatch_id === dispatch.id && worker.agent_terminal_handle === dispatch.assignee_handle
    const profileMatches = readProfileId(worker.start_options) === input.profileId
    const runtimeMatches = worker.runtime_epoch === input.runtimeEpoch
    const active =
      ACTIVE_DISPATCH_STATES.has(dispatch.status) && ACTIVE_WORKER_STATES.has(worker.state)
    const authorityState: LabGatewayCanonicalLifecycle['authorityState'] =
      dispatch.capability_revoked_at !== null
        ? 'revoked'
        : !workerIdentityMatches || !profileMatches || !runtimeMatches
          ? 'invalid'
          : active
            ? 'active'
            : isSettled(dispatch, worker)
              ? 'settled'
              : 'invalid'

    return Object.freeze({
      binding: Object.freeze({
        runId: dispatch.run_id,
        taskId: dispatch.task_id,
        dispatchId: dispatch.id,
        terminalHandle: dispatch.assignee_handle,
        terminalPaneKey: dispatch.assignee_pane_key
      }),
      processIncarnation: dispatch.process_incarnation,
      dispatchCapabilitySha256: dispatch.capability_hash,
      authorityState
    })
  }
}

function hasBoundIdentity(
  dispatch: DispatchContextRow
): dispatch is DispatchContextRow & {
  assignee_handle: string
  assignee_pane_key: string
  process_incarnation: string
} {
  return Boolean(
    dispatch.assignee_handle?.trim() &&
      dispatch.assignee_pane_key?.trim() &&
      dispatch.process_incarnation?.trim()
  )
}

function isSettled(dispatch: DispatchContextRow, worker: WorkerDispatchRow): boolean {
  return (
    !ACTIVE_DISPATCH_STATES.has(dispatch.status) ||
    ['failed', 'succeeded', 'stopped', 'abandoned'].includes(worker.state)
  )
}

function readProfileId(startOptions: string): string | null {
  try {
    const parsed: unknown = JSON.parse(startOptions)
    if (!isRecord(parsed) || !isRecord(parsed.profile)) {
      return null
    }
    return typeof parsed.profile.id === 'string' ? parsed.profile.id : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
