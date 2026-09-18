import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type {
  CodexLabRuntimeCleanupResource,
  CodexLabRuntimeCleanupResult,
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyIdentity
} from './lab-runtime-custody-contract'
import { requireCustody, requireCustodyIdentity } from './lab-runtime-custody-row'
import {
  requireAggregateCustody,
  requireReleasedAggregate,
  throwStateRefusal
} from './lab-runtime-custody-state'
import {
  normalizeCodexLabCleanupResult,
  normalizeCodexLabCustodyIdentity,
  sha256
} from './lab-runtime-custody-validation'

const CLEANUP_COLUMNS: Readonly<
  Record<
    CodexLabRuntimeCleanupResource,
    Readonly<{ state: string; reasonCode: string; detailSha256: string }>
  >
> = Object.freeze({
  layout: Object.freeze({
    state: 'layout_cleanup_state',
    reasonCode: 'layout_cleanup_reason_code',
    detailSha256: 'layout_cleanup_detail_sha256'
  }),
  auth: Object.freeze({
    state: 'auth_cleanup_state',
    reasonCode: 'auth_cleanup_reason_code',
    detailSha256: 'auth_cleanup_detail_sha256'
  }),
  gateway: Object.freeze({
    state: 'gateway_cleanup_state',
    reasonCode: 'gateway_cleanup_reason_code',
    detailSha256: 'gateway_cleanup_detail_sha256'
  }),
  provider: Object.freeze({
    state: 'provider_cleanup_state',
    reasonCode: 'provider_cleanup_reason_code',
    detailSha256: 'provider_cleanup_detail_sha256'
  })
})

export function beginCodexLabRuntimeCleanup(
  this: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabCustodyIdentity(identity)
  return runLifecycleWriteTransaction(this.db, 'begin_codex_lab_runtime_cleanup', () => {
    const current = requireCustodyIdentity(this, evidence)
    if (current.state === 'cleanup_pending') {
      requireAggregateCustody(this, evidence)
      return current
    }
    if (current.state === 'released') {
      throwStateRefusal(evidence.dispatchId, 'cleanup_pending', current.state)
    }
    requireAggregateCustody(this, evidence)
    const changed = this.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET state = 'cleanup_pending', revision = revision + 1, updated_at = datetime('now')
         WHERE dispatch_id = ? AND profile_id = ? AND state = ?`
      )
      .run(evidence.dispatchId, evidence.profileId, current.state)
    if (changed.changes !== 1) {
      throw new Error('Codex laboratory runtime cleanup lost its state comparison.')
    }
    return requireCustody(this, evidence.dispatchId)
  })
}

export function recordCodexLabRuntimeCleanupResult(
  this: OrchestrationDb,
  input: CodexLabRuntimeCleanupResult
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabCleanupResult(input)
  const reasonCode = evidence.reasonCode ?? null
  const detailSha256 = evidence.detailSha256 ?? null
  return runLifecycleWriteTransaction(this.db, 'record_codex_lab_runtime_cleanup', () => {
    const current = requireCustodyIdentity(this, evidence)
    requireCleanupPending(current)
    requireAggregateCustody(this, evidence)
    requireReleaseDependencies(this, current, evidence)
    const entry = current.cleanup[evidence.resource]
    if (entry.state === 'not_created') {
      throw new Error(`Codex laboratory runtime ${evidence.resource} cleanup was never required.`)
    }
    if (entry.state === 'released') {
      if (evidence.outcome === 'released') {
        return current
      }
      throw new Error(`Codex laboratory runtime ${evidence.resource} cleanup cannot move backward.`)
    }
    if (entry.state !== 'pending' && evidence.outcome !== 'released') {
      if (
        entry.state === evidence.outcome &&
        entry.reasonCode === reasonCode &&
        entry.detailSha256 === detailSha256
      ) {
        return current
      }
      throw new Error(`Codex laboratory runtime ${evidence.resource} cleanup is not monotonic.`)
    }
    const columns = CLEANUP_COLUMNS[evidence.resource]
    const changed = this.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET ${columns.state} = ?, ${columns.reasonCode} = ?, ${columns.detailSha256} = ?,
             revision = revision + 1,
             updated_at = datetime('now')
         WHERE dispatch_id = ? AND profile_id = ? AND state = 'cleanup_pending'
           AND ${columns.state} = ?`
      )
      .run(
        evidence.outcome,
        reasonCode,
        detailSha256,
        evidence.dispatchId,
        evidence.profileId,
        entry.state
      )
    if (changed.changes !== 1) {
      throw new Error('Codex laboratory runtime cleanup lost its resource comparison.')
    }
    return requireCustody(this, evidence.dispatchId)
  })
}

export function releaseCodexLabRuntimeCustody(
  this: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabCustodyIdentity(identity)
  return runLifecycleWriteTransaction(this.db, 'release_codex_lab_runtime_custody', () => {
    const current = requireCustodyIdentity(this, evidence)
    if (current.state === 'released') {
      requireReleasedAggregate(this, evidence)
      return current
    }
    requireCleanupPending(current)
    for (const [resource, entry] of Object.entries(current.cleanup)) {
      if (entry.state !== 'not_created' && entry.state !== 'released') {
        throw new Error(`Codex laboratory runtime ${resource} cleanup is not proven.`)
      }
    }
    if (current.auth !== null) {
      requireReleasedProviderResource(this, current)
    }
    requireAggregateCustody(this, evidence)
    const custodyChanged = this.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET state = 'released', revision = revision + 1, updated_at = datetime('now')
         WHERE dispatch_id = ? AND profile_id = ? AND state = 'cleanup_pending'`
      )
      .run(evidence.dispatchId, evidence.profileId)
    if (custodyChanged.changes !== 1) {
      throw new Error('Codex laboratory runtime release lost aggregate cleanup custody.')
    }
    requireReleasedAggregate(this, evidence)
    return requireCustody(this, evidence.dispatchId)
  })
}

function requireCleanupPending(current: CodexLabRuntimeCustody): void {
  if (current.state !== 'cleanup_pending') {
    throwStateRefusal(current.dispatchId, 'cleanup_pending', current.state)
  }
}

function requireReleaseDependencies(
  db: OrchestrationDb,
  current: CodexLabRuntimeCustody,
  input: CodexLabRuntimeCleanupResult
): void {
  if (input.outcome !== 'released') {
    return
  }
  if (input.resource === 'provider') {
    requireReleasedProviderResource(db, current)
  }
  if (input.resource === 'auth' && current.cleanup.provider.state !== 'released') {
    throw new Error('Codex laboratory runtime external auth requires proven provider exit.')
  }
  if (input.resource === 'auth') {
    requireReleasedProviderResource(db, current)
  }
  if (input.resource === 'layout') {
    for (const resource of ['provider', 'gateway', 'auth'] as const) {
      const state = current.cleanup[resource].state
      if (state !== 'not_created' && state !== 'released') {
        throw new Error('Codex laboratory runtime layout cleanup must be released last.')
      }
    }
  }
}

function requireReleasedProviderResource(
  db: OrchestrationDb,
  current: CodexLabRuntimeCustody
): void {
  const provider = current.provider
  if (!provider) {
    throw new Error('Codex laboratory runtime provider exit is not proven.')
  }
  const resource = db.getWorkerTerminalResource(provider.terminalResourceId)
  const sessionId = resource?.terminal_handle.startsWith('structworker_')
    ? resource.terminal_handle.slice('structworker_'.length)
    : ''
  if (
    !resource ||
    resource.id !== provider.terminalResourceId ||
    resource.owner_dispatch_id !== current.dispatchId
  ) {
    throw new Error('Codex laboratory runtime provider exit identity does not match custody.')
  }
  if (
    resource.ownership_state !== 'released' ||
    resource.release_state !== 'released' ||
    resource.release_completed_at === null
  ) {
    throw new Error('Codex laboratory runtime provider exit is not proven.')
  }
  if (
    sha256(sessionId) !== provider.sessionSha256 ||
    sha256(resource.terminal_handle) !== provider.terminalHandleSha256 ||
    resource.pane_key === null ||
    sha256(resource.pane_key) !== provider.terminalPaneKeySha256 ||
    resource.process_incarnation === null ||
    sha256(resource.process_incarnation) !== provider.processIncarnationSha256
  ) {
    throw new Error('Codex laboratory runtime provider exit identity does not match custody.')
  }
}
