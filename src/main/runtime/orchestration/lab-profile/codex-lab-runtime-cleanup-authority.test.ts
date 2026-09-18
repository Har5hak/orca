import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db'
import type {
  CodexLabRuntimeCleanupReasonCode,
  CodexLabRuntimeCleanupResource,
  CodexLabRuntimeCleanupState,
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyState
} from '../db/lab-runtime-custody/lab-runtime-custody-contract'
import type { WorkerTerminalResourceRow } from '../worker-terminal-ownership'
import {
  cleanupReleasedCodexLabRuntime,
  registerCodexLabRuntimeCleanupAuthority
} from './codex-lab-runtime-cleanup-authority'
import type { CodexLabRuntimeLayoutRemovalEvidence } from './codex-lab-runtime-layout'
import { createCodexLabExternalChatGptAuthHostFactory } from '../../../codex/codex-lab-external-chatgpt-auth-authority'
import {
  registerCodexLabExternalChatGptAuthAuthority,
  releaseCodexLabExternalChatGptAuthAuthority
} from './codex-lab-external-chatgpt-auth-registry-internal'

const SESSION = '11111111-1111-4111-8111-111111111111'
const HANDLE = 'structworker_33333333-3333-4333-8333-333333333333'
const PANE = `agent-session-${SESSION}:22222222-2222-4222-8222-222222222222`
const PROCESS = `structured:${SESSION}`
const ALTERNATE_SESSION = '44444444-4444-4444-8444-444444444444'
const ALTERNATE_HANDLE = 'structworker_55555555-5555-4555-8555-555555555555'
const ALTERNATE_PANE = `agent-session-${ALTERNATE_SESSION}:66666666-6666-4666-8666-666666666666`
const ALTERNATE_PROCESS = `structured:${ALTERNATE_SESSION}`
const registeredAuth: string[] = []
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const dispatchId of registeredAuth.splice(0)) {
    releaseCodexLabExternalChatGptAuthAuthority(SESSION, dispatchId)
  }
  for (const database of databases.splice(0)) {
    database.close()
  }
  vi.restoreAllMocks()
})

function resource(dispatchId: string): WorkerTerminalResourceRow {
  return {
    id: `wtr_${dispatchId}`,
    origin_dispatch_id: dispatchId,
    owner_dispatch_id: dispatchId,
    prior_owner_dispatch_ids: '[]',
    worktree_id: 'repo::cleanup-fixture',
    terminal_handle: HANDLE,
    pane_key: PANE,
    process_incarnation: PROCESS,
    endpoint_id: null,
    endpoint_incarnation: null,
    host_scope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    ownership_state: 'released',
    release_state: 'released',
    retained_reason: null,
    release_requested_at: '2026-09-18T08:59:59.000Z',
    release_completed_at: '2026-09-18T09:00:00.000Z',
    release_error: null,
    recovery_attempt_count: 0,
    last_recovery_at: null,
    archive_source: null,
    archive_status: null,
    created_at: '2026-09-18T08:59:00.000Z',
    updated_at: '2026-09-18T09:00:00.000Z'
  }
}

function database(
  events: string[],
  custodyState: CodexLabRuntimeCustodyState = 'ready',
  dispatchId = 'ctx_cleanup_fixture'
): OrchestrationDb {
  type MutableCleanupEntry = {
    state: CodexLabRuntimeCleanupState
    reasonCode: CodexLabRuntimeCleanupReasonCode | null
    detailSha256: string | null
  }
  const pending = (): MutableCleanupEntry => ({
    state: 'pending',
    reasonCode: null,
    detailSha256: null
  })
  const cleanup: Record<CodexLabRuntimeCleanupResource, MutableCleanupEntry> = {
    layout: pending(),
    auth: pending(),
    gateway: pending(),
    provider: pending()
  }
  const custody = (): CodexLabRuntimeCustody => ({
    dispatchId,
    profileId: 'lab-readonly-supervised-v1',
    state: custodyState,
    runtimeRoot: runtimeRoot(dispatchId),
    runtimeParentIdentity: { device: '1', inode: '1' },
    runtimeRootIdentity: { device: '1', inode: '2' },
    configSha256: 'a'.repeat(64),
    auth: null,
    gatewayReceipt: null,
    provider: null,
    cleanup,
    revision: 1,
    createdAt: '2026-09-18T08:00:00.000Z',
    updatedAt: '2026-09-18T09:00:00.000Z'
  })
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  vi.spyOn(db, 'getCodexLabRuntimeCustody').mockImplementation(() => custody())
  vi.spyOn(db, 'beginCodexLabRuntimeCleanup').mockImplementation(() => {
    events.push('custody:begin')
    return custody()
  })
  vi.spyOn(db, 'recordCodexLabRuntimeCleanupResult').mockImplementation((input) => {
    events.push(`${input.resource}:${input.outcome}`)
    cleanup[input.resource].state = input.outcome
    cleanup[input.resource].reasonCode = input.reasonCode ?? null
    cleanup[input.resource].detailSha256 = input.detailSha256 ?? null
    return custody()
  })
  vi.spyOn(db, 'releaseCodexLabRuntimeCustody').mockImplementation(() => {
    events.push('custody:release')
    return custody()
  })
  return db
}

function register(
  dispatchId: string,
  events: string[],
  stopGateway = async () => undefined,
  removalEvidence: CodexLabRuntimeLayoutRemovalEvidence = validRemovalEvidence(dispatchId)
) {
  return registerCodexLabRuntimeCleanupAuthority({
    dispatchId,
    sessionId: SESSION,
    terminalHandle: HANDLE,
    terminalPaneKey: PANE,
    processIncarnation: PROCESS,
    stopGateway: async () => {
      events.push('gateway:stop')
      await stopGateway()
    },
    removeLayout: async () => {
      events.push('layout:remove')
      return removalEvidence
    }
  })
}

describe('Codex laboratory runtime cleanup authority', () => {
  it('rejects a cleanup authority whose process incarnation names another session', () => {
    expect(() =>
      registerCodexLabRuntimeCleanupAuthority({
        dispatchId: 'ctx_cleanup_identity_mismatch',
        sessionId: SESSION,
        terminalHandle: HANDLE,
        terminalPaneKey: PANE,
        processIncarnation: 'structured:44444444-4444-4444-8444-444444444444',
        stopGateway: async () => undefined,
        removeLayout: async () => validRemovalEvidence('ctx_cleanup_identity_mismatch')
      })
    ).toThrow('cleanup authority conflicts or is invalid')
  })

  it('keeps one authority per dispatch and a stale unregister cannot delete its replacement', () => {
    const dispatchId = 'ctx_cleanup_unique_dispatch'
    const unregisterFirst = register(dispatchId, [])
    const registerAlternate = () =>
      registerCodexLabRuntimeCleanupAuthority({
        dispatchId,
        sessionId: ALTERNATE_SESSION,
        terminalHandle: ALTERNATE_HANDLE,
        terminalPaneKey: ALTERNATE_PANE,
        processIncarnation: ALTERNATE_PROCESS,
        stopGateway: async () => undefined,
        removeLayout: async () => validRemovalEvidence(dispatchId)
      })

    expect(registerAlternate).toThrow('cleanup authority conflicts or is invalid')
    expect(unregisterFirst()).toBe(true)
    const unregisterAlternate = registerAlternate()
    expect(unregisterFirst()).toBe(false)
    expect(() => register(dispatchId, [])).toThrow('cleanup authority conflicts or is invalid')
    expect(unregisterAlternate()).toBe(true)
  })

  it('awaits gateway then layout and releases custody only after both', async () => {
    const dispatchId = 'ctx_cleanup_happy'
    const events: string[] = []
    register(dispatchId, events)

    await expect(
      cleanupReleasedCodexLabRuntime({
        db: database(events, 'ready', dispatchId),
        dispatchId,
        resource: resource(dispatchId)
      })
    ).resolves.toBe('released')
    expect(events).toEqual([
      'custody:begin',
      'provider:released',
      'auth:released',
      'gateway:stop',
      'gateway:released',
      'layout:remove',
      'layout:released',
      'custody:release'
    ])
  })

  it('retains authority and cleanup_pending for an idempotent retry', async () => {
    const dispatchId = 'ctx_cleanup_retry'
    const events: string[] = []
    const stop = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined)
    register(dispatchId, events, stop)
    const db = database(events, 'ready', dispatchId)

    await expect(
      cleanupReleasedCodexLabRuntime({ db, dispatchId, resource: resource(dispatchId) })
    ).resolves.toBe('cleanup_pending')
    await expect(
      cleanupReleasedCodexLabRuntime({ db, dispatchId, resource: resource(dispatchId) })
    ).resolves.toBe('released')
    expect(stop).toHaveBeenCalledTimes(2)
    expect(events.at(-1)).toBe('custody:release')
  })

  it('does not release auth, gateway or layout while auth authority remains registered', async () => {
    const dispatchId = 'ctx_cleanup_auth_live'
    const events: string[] = []
    register(dispatchId, events)
    const binding = {
      dispatchId,
      sessionId: SESSION,
      workspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42'
    }
    registerCodexLabExternalChatGptAuthAuthority({
      ...binding,
      factory: createCodexLabExternalChatGptAuthHostFactory({
        binding,
        credential: {
          type: 'chatgptAuthTokens',
          accessToken: jwt({ exp: Math.floor(Date.now() / 1_000) + 600 }),
          chatgptAccountId: binding.workspaceId,
          chatgptPlanType: 'business'
        },
        refresh: async () => {
          throw new Error('unused')
        }
      })
    })
    registeredAuth.push(dispatchId)

    await expect(
      cleanupReleasedCodexLabRuntime({
        db: database(events, 'ready', dispatchId),
        dispatchId,
        resource: resource(dispatchId)
      })
    ).resolves.toBe('cleanup_pending')
    expect(events).toContain('auth:unproven')
    expect(events).not.toContain('gateway:stop')
    expect(events).not.toContain('layout:remove')
  })

  it('keeps durable Codex custody pending when in-memory authority is missing', async () => {
    await expect(
      cleanupReleasedCodexLabRuntime({
        db: database([], 'cleanup_pending'),
        dispatchId: 'ctx_cleanup_restarted',
        resource: resource('ctx_cleanup_restarted')
      })
    ).resolves.toBe('cleanup_pending')
  })

  it.each([null, 'malformed'])(
    'keeps active durable custody pending when process incarnation is %s',
    async (processIncarnation) => {
      const dispatchId = `ctx_cleanup_invalid_incarnation_${processIncarnation ?? 'null'}`
      await expect(
        cleanupReleasedCodexLabRuntime({
          db: database([], 'cleanup_pending', dispatchId),
          dispatchId,
          resource: { ...resource(dispatchId), process_incarnation: processIncarnation }
        })
      ).resolves.toBe('cleanup_pending')
    }
  )

  it('returns not_registered for a malformed incarnation without durable custody', async () => {
    const dispatchId = 'ctx_cleanup_invalid_incarnation_without_custody'
    const db = database([], 'cleanup_pending', dispatchId)
    vi.mocked(db.getCodexLabRuntimeCustody).mockReturnValue(undefined)

    await expect(
      cleanupReleasedCodexLabRuntime({
        db,
        dispatchId,
        resource: { ...resource(dispatchId), process_incarnation: 'malformed' }
      })
    ).resolves.toBe('not_registered')
  })

  it('keeps custody pending when layout revocation evidence names another quarantine', async () => {
    const dispatchId = 'ctx_cleanup_wrong_quarantine'
    const events: string[] = []
    register(dispatchId, events, async () => undefined, {
      ...validRemovalEvidence(dispatchId),
      quarantinePath: '/private/tmp/orca-lab/runtime/dispatches/.wrong.cleanup-quarantine'
    })

    await expect(
      cleanupReleasedCodexLabRuntime({
        db: database(events, 'ready', dispatchId),
        dispatchId,
        resource: resource(dispatchId)
      })
    ).resolves.toBe('cleanup_pending')
    expect(events).toContain('layout:failed')
    expect(events).not.toContain('custody:release')
  })
})

function runtimeRoot(dispatchId: string): string {
  return `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}`
}

function validRemovalEvidence(dispatchId: string): CodexLabRuntimeLayoutRemovalEvidence {
  return Object.freeze({
    evidence: 'identity-fenced-active-layout-revoked',
    quarantinePath: `/private/tmp/orca-lab/runtime/dispatches/.${dispatchId}.cleanup-quarantine`,
    rootIdentity: Object.freeze({ device: '1', inode: '2' })
  })
}

function jwt(payload: Record<string, unknown>): string {
  return ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.')
}
