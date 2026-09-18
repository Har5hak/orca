import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { finishReleasedWorkerCodexLabCleanup } from './worker-release-lab-cleanup'

export async function reconcileExitedFailedLabProvider(input: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
}): Promise<void> {
  const resource = input.db.getWorkerTerminalResourceByOwner(input.dispatchId)
  if (
    !resource?.process_incarnation ||
    (await input.runtime.inspectTerminalProcessIncarnationLiveness(
      resource.process_incarnation,
      resource.host_scope
    )) !== 'exited'
  ) {
    return
  }
  const settled = input.db.settleDeadWorkerTerminalRelease({
    requestingDispatchId: input.dispatchId,
    resourceId: resource.id,
    processIncarnation: resource.process_incarnation
  })
  if (settled.disposition === 'released') {
    await finishReleasedWorkerCodexLabCleanup(
      input.db,
      input.dispatchId,
      settled.resource,
      'released'
    )
  }
}
