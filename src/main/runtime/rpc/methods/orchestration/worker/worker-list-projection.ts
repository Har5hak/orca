import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  type FleetDurableWorker
} from '../../../../../../shared/orchestration-fleet-projection'
import { resolveFleetWorkerOutcome } from '../../../../../../shared/orchestration-fleet-outcome-resolution'
import { createFleetStatusIndex } from '../../../../../../shared/orchestration-fleet-status-index'
import type { WorkerTerminalListState } from '../../../../orchestration/worker-terminal-ownership'
import type { OrchestrationDb } from '../../../../orchestration/db'

export type WorkerListPageParams = {
  run?: string
  terminalState?: WorkerTerminalListState
  includeRemote?: boolean
  paginate?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type DurableProviderSelection = NonNullable<FleetDurableWorker['durableProviderTruth']>['requested']

function providerFromLaunchSelection(value: unknown): DurableProviderSelection {
  if (!isRecord(value)) {
    return null
  }
  const agent =
    value.agent === null
      ? null
      : typeof value.agent === 'string' && value.agent.trim() !== ''
        ? value.agent.trim()
        : undefined
  if (agent === undefined) {
    return null
  }
  return {
    id: agent,
    model: typeof value.model === 'string' && value.model.trim() !== '' ? value.model.trim() : null,
    effort:
      typeof value.effort === 'string' && value.effort.trim() !== '' ? value.effort.trim() : null
  }
}

function readDurableProviderTruth(
  startOptions: string | null
): FleetDurableWorker['durableProviderTruth'] {
  if (!startOptions) {
    return { requested: null, effective: null, effectiveSource: null }
  }
  try {
    const parsed: unknown = JSON.parse(startOptions)
    if (!isRecord(parsed)) {
      return { requested: null, effective: null, effectiveSource: null }
    }
    if (Object.hasOwn(parsed, 'launch')) {
      if (!isRecord(parsed.launch)) {
        return { requested: null, effective: null, effectiveSource: null }
      }
      const launch = parsed.launch
      const requested = providerFromLaunchSelection(launch.requested)
      const effective = providerFromLaunchSelection(launch.effective)
      return {
        requested,
        effective,
        effectiveSource: effective ? 'launch_receipt' : null
      }
    }
    const legacy = providerFromLaunchSelection(parsed)
    const legacyEffective =
      typeof legacy?.id === 'string' ? { ...legacy, model: null, effort: null } : null
    return {
      requested: null,
      effective: legacyEffective,
      effectiveSource: legacyEffective ? 'legacy_start_options' : null
    }
  } catch {
    return { requested: null, effective: null, effectiveSource: null }
  }
}

export function projectWorkerFleet(args: {
  rows: ReturnType<OrchestrationDb['listWorkerTerminalResources']>
  attentionFacts: ReturnType<OrchestrationDb['getWorkerAttentionFactsForDispatches']>
  statuses: Parameters<typeof projectOrchestrationFleet>[0]['statuses']
  limit: number
  now: number
  completeProjection?: boolean
  identityScopeComplete?: boolean
}) {
  const workers: FleetDurableWorker[] = args.rows.map((row) => {
    return {
      ...row,
      outcome: resolveFleetWorkerOutcome({
        attemptOutcome: args.attentionFacts.get(row.dispatchId)?.outcome ?? 'outcome_unknown',
        workerState: row.workerState,
        dispatchStatus: row.dispatchStatus
      }),
      durableProviderTruth: readDurableProviderTruth(row.startOptions),
      dispatchHostScope: row.dispatchHostScope,
      federatedEnvironmentId: row.federatedEnvironmentId,
      resource: row.resource
        ? {
            id: row.resource.id,
            ownerDispatchId: row.resource.owner_dispatch_id,
            worktreeId: row.resource.worktree_id,
            paneKey: row.resource.pane_key,
            processIncarnation: row.resource.process_incarnation,
            endpointId: row.resource.endpoint_id,
            endpointIncarnation: row.resource.endpoint_incarnation,
            hostScope: row.resource.host_scope,
            ownershipState: row.resource.ownership_state,
            releaseState: row.resource.release_state,
            updatedAt: row.resource.updated_at
          }
        : null
    }
  })
  const durable = new Map(workers.map((worker) => [worker.dispatchId, worker]))
  if (!args.completeProjection) {
    return {
      ...projectOrchestrationFleet({
        workers,
        statuses: args.statuses,
        limit: args.limit,
        now: args.now,
        identityScopeComplete: args.identityScopeComplete
      }),
      durable
    }
  }

  const projections: ReturnType<typeof projectOrchestrationFleet>['workers'] = []
  const statusIndex = createFleetStatusIndex(
    args.statuses,
    workers,
    args.identityScopeComplete === true
  )
  for (let offset = 0; offset < workers.length; offset += ORCHESTRATION_FLEET_PAGE_MAX) {
    projections.push(
      ...projectOrchestrationFleet({
        workers: workers.slice(offset, offset + ORCHESTRATION_FLEET_PAGE_MAX),
        statuses: args.statuses,
        limit: ORCHESTRATION_FLEET_PAGE_MAX,
        now: args.now,
        statusIndex
      }).workers
    )
  }
  return {
    workers: projections,
    page: { limit: workers.length, total: workers.length, hasMore: false, nextCursor: null },
    durable
  }
}
