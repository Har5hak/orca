import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type {
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyIdentity
} from './lab-runtime-custody-contract'
import { requireCustody, requireCustodyIdentity } from './lab-runtime-custody-row'
import { requireAggregateCustody, requireReleasedAggregate } from './lab-runtime-custody-state'
import { normalizeCodexLabCustodyIdentity } from './lab-runtime-custody-validation'

/**
 * Atomically retires the synthetic structured-terminal reservation and aggregate runtime custody
 * when host preparation refused before returning a launch binding.
 *
 * While the structured before-attach callback is still running, the provider cannot have been
 * spawned. This narrow transition accepts only the exact monotonic pre-attach phases and requires
 * the host composer to have proven release of every resource represented by those phases.
 */
export function releaseCodexLabPreAttachRuntimeCustody(
  this: OrchestrationDb,
  input: CodexLabRuntimeCustodyIdentity &
    Readonly<{
      terminalHandle: string
      terminalPaneKey: string
      processIncarnation: string
    }>
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabCustodyIdentity({
    dispatchId: input.dispatchId,
    profileId: input.profileId
  })
  return runLifecycleWriteTransaction(this.db, 'release_codex_lab_pre_attach_runtime', () => {
    const current = requireCustodyIdentity(this, evidence)
    if (current.state === 'released') {
      requireReleasedAggregate(this, evidence)
      return current
    }
    if (!isPreAttachCleanupState(current)) {
      throw new Error('Codex laboratory pre-attach cleanup found inconsistent host authority.')
    }
    requireAggregateCustody(this, evidence)
    const dispatch = this.getDispatchContextById(evidence.dispatchId)
    const worker = this.getWorkerDispatch(evidence.dispatchId)
    const resource = this.getWorkerTerminalResourceByOwner(evidence.dispatchId)
    if (
      dispatch?.status !== 'pending' ||
      worker?.state !== 'starting' ||
      worker.agent_terminal_handle !== input.terminalHandle ||
      dispatch.assignee_handle !== input.terminalHandle ||
      dispatch.assignee_pane_key !== input.terminalPaneKey ||
      dispatch.process_incarnation !== input.processIncarnation ||
      !resource ||
      resource.owner_dispatch_id !== evidence.dispatchId ||
      resource.terminal_handle !== input.terminalHandle ||
      resource.pane_key !== input.terminalPaneKey ||
      resource.process_incarnation !== input.processIncarnation ||
      resource.ownership_state !== 'owned' ||
      resource.release_state !== 'not_requested' ||
      !input.terminalHandle.startsWith('structworker_')
    ) {
      throw new Error('Codex laboratory pre-attach terminal authority does not match custody.')
    }
    const terminalChanged = this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET ownership_state = 'released', release_state = 'released', retained_reason = NULL,
             release_requested_at = datetime('now'), release_completed_at = datetime('now'),
             release_error = NULL, archive_status = 'unavailable', updated_at = datetime('now')
         WHERE id = ? AND owner_dispatch_id = ? AND ownership_state = 'owned'
           AND release_state = 'not_requested'`
      )
      .run(resource.id, evidence.dispatchId)
    if (terminalChanged.changes !== 1) {
      throw new Error('Codex laboratory pre-attach terminal release lost its comparison.')
    }
    const cleanupChanged = this.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET state = 'cleanup_pending',
             layout_cleanup_state = CASE
               WHEN layout_cleanup_state = 'pending' THEN 'released'
               ELSE layout_cleanup_state
             END,
             gateway_cleanup_state = CASE
               WHEN gateway_cleanup_state = 'pending' THEN 'released'
               ELSE gateway_cleanup_state
             END,
             provider_cleanup_state = CASE
               WHEN provider_cleanup_state = 'pending' THEN 'released'
               ELSE provider_cleanup_state
             END,
             revision = revision + 1, updated_at = datetime('now')
         WHERE dispatch_id = ? AND profile_id = ? AND state = ?`
      )
      .run(evidence.dispatchId, evidence.profileId, current.state)
    if (cleanupChanged.changes !== 1) {
      throw new Error('Codex laboratory pre-attach cleanup lost its state comparison.')
    }
    const releaseChanged = this.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET state = 'released', revision = revision + 1, updated_at = datetime('now')
         WHERE dispatch_id = ? AND profile_id = ? AND state = 'cleanup_pending'`
      )
      .run(evidence.dispatchId, evidence.profileId)
    if (releaseChanged.changes !== 1) {
      throw new Error('Codex laboratory pre-attach release lost its state comparison.')
    }
    requireReleasedAggregate(this, evidence)
    return requireCustody(this, evidence.dispatchId)
  })
}

function isPreAttachCleanupState(current: CodexLabRuntimeCustody): boolean {
  const expected = {
    authority_attached: { layout: 'not_created', provider: 'not_created', gateway: 'not_created' },
    layout_prepared: { layout: 'pending', provider: 'not_created', gateway: 'not_created' },
    provider_reserved: { layout: 'pending', provider: 'pending', gateway: 'not_created' },
    gateway_started: { layout: 'pending', provider: 'pending', gateway: 'pending' }
  } as const
  if (current.auth !== null || current.cleanup.auth.state !== 'not_created') {
    return false
  }
  let phase: (typeof expected)[keyof typeof expected]
  switch (current.state) {
    case 'authority_attached':
      phase = expected.authority_attached
      break
    case 'layout_prepared':
      phase = expected.layout_prepared
      break
    case 'provider_reserved':
      phase = expected.provider_reserved
      break
    case 'gateway_started':
      phase = expected.gateway_started
      break
    case 'planned':
    case 'external_auth_installed':
    case 'provider_attached':
    case 'ready':
    case 'cleanup_pending':
    case 'released':
      return false
  }
  return (
    current.cleanup.layout.state === phase.layout &&
    current.cleanup.provider.state === phase.provider &&
    current.cleanup.gateway.state === phase.gateway
  )
}
