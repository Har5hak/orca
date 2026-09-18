import type { OrchestrationDb } from '../../../../orchestration/db'
import { cleanupReleasedCodexLabRuntime } from '../../../../orchestration/lab-profile/codex-lab-runtime-cleanup-authority'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'

export async function finishReleasedWorkerCodexLabCleanup(
  db: OrchestrationDb,
  dispatchId: string,
  resource: WorkerTerminalResourceRow,
  releasedState: 'released' | 'already_released'
): Promise<
  { state: 'released' | 'already_released' } | { state: 'release_pending'; recovery: string }
> {
  const cleanup = await cleanupReleasedCodexLabRuntime({ db, dispatchId, resource })
  return cleanup === 'cleanup_pending'
    ? {
        state: 'release_pending',
        recovery: codexLabCleanupPendingRecovery(dispatchId)
      }
    : { state: releasedState }
}

export function codexLabCleanupPendingRecovery(dispatchId: string): string {
  return `The provider exit is proven; Codex laboratory runtime cleanup remains pending. Retry worker-release for ${dispatchId} with a fresh request ID (omit --retry-request to let the CLI generate one). Reusing the prior request ID only replays this release_pending receipt.`
}
