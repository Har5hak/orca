import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { stopStructuredWorker } from '../../orchestration-structured-worker-lifecycle'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { archiveSummary } from './worker-terminal-resource-presentation'
import type { WorkerReleaseReceipt } from './worker-release-completion'
import { finishReleasedWorkerCodexLabCleanup } from './worker-release-lab-cleanup'

/**
 * The close half of a release for a worker that IS a structured session.
 *
 * Separate from the PTY close for the same reason the delivery lane is: there is no terminal to
 * close and no exit to observe, so the host's own settlement is the only proof available. Only a
 * proven close may settle; an unproven one reports `release_unknown` and needs a fresh request id
 * to retry rather than replaying the durable receipt.
 */
export async function stopStructuredWorkerForRelease(args: {
  structured: StructuredWorkerIdentity
  dispatchId: string
  resource: WorkerTerminalResourceRow
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  archiveSource: string | null
  archiveStatus: string | null
}): Promise<WorkerReleaseReceipt> {
  const { structured, dispatchId, resource, runtime, db } = args
  const stop = await stopStructuredWorker(structured, dispatchId, runtime)
  if (!stop.stopped) {
    const unknown = db.markWorkerTerminalReleaseUnknown(
      resource.id,
      stop.reason ?? 'The structured session close was not proven.'
    )
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: stop.closeAttempted ? 'closed_agent_terminal' : 'none',
      archive: { source: args.archiveSource, status: args.archiveStatus },
      lastError: unknown.release_error ?? stop.reason,
      recovery: `Inspect with: orca orchestration worker-show --dispatch ${dispatchId} --json — then retry worker-release with a fresh request ID (omit --retry-request to let the CLI generate one). Reusing the prior request ID only replays this release_unknown receipt.`
    }
  }
  const settled = db.settleWorkerTerminalRelease(resource.id)
  const cleanup = await finishReleasedWorkerCodexLabCleanup(db, dispatchId, settled, 'released')
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    ...cleanup,
    processAction: 'closed_agent_terminal',
    archive: archiveSummary(settled)
  }
}
