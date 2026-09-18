import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const stopStructuredWorker = vi.hoisted(() => vi.fn())
const cleanupReleasedCodexLabRuntime = vi.hoisted(() => vi.fn())

vi.mock('../../orchestration-structured-worker-lifecycle', () => ({ stopStructuredWorker }))
vi.mock('../../../../orchestration/lab-profile/codex-lab-runtime-cleanup-authority', () => ({
  cleanupReleasedCodexLabRuntime
}))

import { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../../../orchestration/worker-terminal-ownership'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { stopStructuredWorkerForRelease } from './structured-worker-release-stop'

const DISPATCH_ID = 'ctx_structured_release'
const STRUCTURED = {
  handle: 'structworker_33333333-3333-4333-8333-333333333333',
  sessionId: '11111111-1111-4111-8111-111111111111',
  agent: 'codex',
  paneKey: 'agent-session-1:22222222-2222-4222-8222-222222222222',
  processIncarnation: 'structured:11111111-1111-4111-8111-111111111111',
  worktreeId: 'repo::worktree',
  hostScope: { kind: 'local', hostId: 'local' }
} satisfies StructuredWorkerIdentity

const RELEASED_RESOURCE = {
  id: 'wtr_structured_release',
  origin_dispatch_id: DISPATCH_ID,
  owner_dispatch_id: DISPATCH_ID,
  prior_owner_dispatch_ids: '[]',
  worktree_id: STRUCTURED.worktreeId,
  terminal_handle: STRUCTURED.handle,
  pane_key: STRUCTURED.paneKey,
  process_incarnation: STRUCTURED.processIncarnation,
  endpoint_id: STRUCTURED.sessionId,
  endpoint_incarnation: STRUCTURED.processIncarnation,
  host_scope: JSON.stringify(STRUCTURED.hostScope),
  ownership_state: 'released',
  release_state: 'released',
  retained_reason: null,
  release_requested_at: '2026-09-18T09:00:00.000Z',
  release_completed_at: '2026-09-18T09:00:01.000Z',
  release_error: null,
  recovery_attempt_count: 0,
  last_recovery_at: null,
  archive_source: 'transcript',
  archive_status: 'captured',
  created_at: '2026-09-18T09:00:00.000Z',
  updated_at: '2026-09-18T09:00:01.000Z'
} satisfies WorkerTerminalResourceRow

const RELEASING_RESOURCE = {
  ...RELEASED_RESOURCE,
  ownership_state: 'owned',
  release_state: 'releasing',
  release_completed_at: null
} satisfies WorkerTerminalResourceRow

describe('structured worker release stop', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    stopStructuredWorker.mockReset()
    cleanupReleasedCodexLabRuntime.mockReset()
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('surfaces cleanup_pending after the structured provider exit is proven', async () => {
    stopStructuredWorker.mockResolvedValue({ stopped: true, closeAttempted: true })
    cleanupReleasedCodexLabRuntime.mockResolvedValue('cleanup_pending')
    vi.spyOn(db, 'settleWorkerTerminalRelease').mockReturnValue(RELEASED_RESOURCE)

    const receipt = await stopStructuredWorkerForRelease({
      structured: STRUCTURED,
      dispatchId: DISPATCH_ID,
      resource: RELEASING_RESOURCE,
      runtime,
      db,
      archiveSource: 'transcript',
      archiveStatus: 'captured'
    })

    expect(receipt.state).toBe('release_pending')
    expect(receipt.recovery).toContain('fresh request ID')
    expect(cleanupReleasedCodexLabRuntime).toHaveBeenCalledWith({
      db,
      dispatchId: DISPATCH_ID,
      resource: RELEASED_RESOURCE
    })
  })

  it('requires a fresh request ID when the structured provider exit is unproven', async () => {
    stopStructuredWorker.mockResolvedValue({
      stopped: false,
      closeAttempted: true,
      reason: 'provider exit is unproven'
    })
    vi.spyOn(db, 'markWorkerTerminalReleaseUnknown').mockReturnValue({
      ...RELEASING_RESOURCE,
      release_state: 'unknown',
      release_error: 'provider exit is unproven'
    })

    const receipt = await stopStructuredWorkerForRelease({
      structured: STRUCTURED,
      dispatchId: DISPATCH_ID,
      resource: RELEASING_RESOURCE,
      runtime,
      db,
      archiveSource: 'transcript',
      archiveStatus: 'captured'
    })

    expect(receipt.state).toBe('release_unknown')
    expect(receipt.recovery).toContain('fresh request ID')
    expect(receipt.recovery).not.toContain('same --retry-request')
    expect(cleanupReleasedCodexLabRuntime).not.toHaveBeenCalled()
  })
})
