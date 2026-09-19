import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../../db'
import { SCHEMA_VERSION } from '../contract-constants'
import { parseCodexLabLaunchReceipt } from '../../lab-profile/codex-lab-launch-receipt'
import { testCodexLabStructuredLaunchBinding } from '../../lab-profile/codex-lab-structured-launch-binding-test-support'
import { LAB_GATEWAY_ALLOWED_OPERATIONS } from '../../lab-profile/dispatch-gateway-policy-contract'
import { expectedCodexLabDispatchRuntimeRoot, sha256 } from './lab-runtime-custody-validation'
import { exposeCodexLabRuntimeCustody } from '../../../rpc/methods/orchestration/worker/worker-observation'
import {
  PROCESS_INCARNATION,
  PROFILE_ID,
  PROVIDER_ID,
  SESSION_ID,
  TERMINAL_HANDLE,
  TERMINAL_PANE_KEY,
  advanceTo,
  cleanupCodexLabCustodyTestHarnesses,
  closeTrackedDatabase,
  createHarness as createHarnessWithBinding,
  gatewayReceipt,
  launchReceipt,
  plan,
  proveCreatedResourcesReleased,
  providerEvidence,
  trackDatabase,
  trackTempRoot
} from './lab-runtime-custody-store.test-support'

function createHarness(spec = 'persist Codex lab runtime custody', databasePath = ':memory:') {
  return createHarnessWithBinding(
    (dispatchId) => testCodexLabStructuredLaunchBinding({ dispatchId }),
    spec,
    databasePath
  )
}

afterEach(() => {
  cleanupCodexLabCustodyTestHarnesses()
})

describe('Codex laboratory runtime custody', () => {
  it('has no durable field capable of naming bearer, token, credential, secret or DCap material', () => {
    const harness = createHarness()
    const columnNames = harness.db.db
      .prepare("SELECT name FROM pragma_table_info('codex_lab_runtime_custody')")
      .all()
      .map((row) => String(row.name))

    expect(columnNames.join(' ')).not.toMatch(/bearer|token|credential|secret|dcap/iu)
    expect(columnNames).not.toContain('terminal_handle')
    expect(columnNames).not.toContain('terminal_pane_key')
    expect(columnNames.some((name) => name.endsWith('_error'))).toBe(false)
  })

  it('persists only public evidence through the exact monotonic launch sequence', () => {
    const harness = createHarness()
    const ready = advanceTo(harness, 'ready')

    expect(ready).toMatchObject({
      dispatchId: harness.dispatchId,
      profileId: PROFILE_ID,
      state: 'ready',
      runtimeRoot: expectedCodexLabDispatchRuntimeRoot(harness.dispatchId),
      runtimeParentIdentity: { device: '1', inode: '2' },
      runtimeRootIdentity: { device: '1', inode: '3' },
      configSha256: expect.any(String),
      auth: {
        method: 'chatgptAuthTokens',
        storage: 'ephemeral',
        loginStartAccepted: true,
        authJsonAbsent: true
      },
      gatewayReceipt: {
        dispatchId: harness.dispatchId,
        allowedOperations: LAB_GATEWAY_ALLOWED_OPERATIONS
      },
      provider: {
        id: PROVIDER_ID,
        sessionSha256: sha256(SESSION_ID),
        terminalHandleSha256: sha256(TERMINAL_HANDLE),
        terminalPaneKeySha256: sha256(TERMINAL_PANE_KEY),
        processIncarnationSha256: sha256(PROCESS_INCARNATION)
      },
      cleanup: {
        layout: { state: 'pending', reasonCode: null, detailSha256: null },
        auth: { state: 'pending', reasonCode: null, detailSha256: null },
        gateway: { state: 'pending', reasonCode: null, detailSha256: null },
        provider: { state: 'pending', reasonCode: null, detailSha256: null }
      },
      revision: 8
    })
    const serialized = JSON.stringify(ready)
    expect(serialized).not.toContain('lgw1_')
    expect(serialized).not.toContain('dcap_')
    expect(serialized).not.toContain('Bearer ')
    expect(serialized).not.toContain(TERMINAL_HANDLE)
    expect(serialized).not.toContain(TERMINAL_PANE_KEY)
    const durableCustody = harness.db.db
      .prepare('SELECT * FROM codex_lab_runtime_custody WHERE dispatch_id = ?')
      .get(harness.dispatchId)
    expect(JSON.stringify(durableCustody)).not.toContain(TERMINAL_HANDLE)
    expect(JSON.stringify(durableCustody)).not.toContain(TERMINAL_PANE_KEY)
  })

  it('reopens and replays the exact immutable worker-show launch receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-lab-launch-receipt-'))
    trackTempRoot(root)
    const path = join(root, 'orchestration.db')
    const harness = createHarness('reopen the Codex lab launch receipt', path)
    const ready = advanceTo(harness, 'ready')
    const receipt = ready.launchReceipt
    if (!receipt) {
      throw new Error('expected persisted launch receipt')
    }
    closeTrackedDatabase(harness.db)

    const reopened = new OrchestrationDb(path)
    trackDatabase(reopened)
    const shown = exposeCodexLabRuntimeCustody(reopened, harness.dispatchId)
    expect(shown?.launchReceipt).toEqual(receipt)
    expect(Object.isFrozen(shown?.launchReceipt?.gateway.policyReceipt.binding)).toBe(true)
    const reopenedDispatch = reopened.getDispatchContextById(harness.dispatchId)
    expect(shown?.launchReceipt?.gateway).toEqual(shown?.gatewayReceipt)
    expect(shown?.launchReceipt?.gateway.policyReceipt.binding).toMatchObject({
      runIdSha256: sha256(reopenedDispatch?.run_id ?? ''),
      taskIdSha256: sha256(reopenedDispatch?.task_id ?? ''),
      dispatchIdSha256: sha256(reopenedDispatch?.id ?? ''),
      terminalHandleSha256: shown?.provider?.terminalHandleSha256,
      terminalPaneKeySha256: shown?.provider?.terminalPaneKeySha256
    })
    expect(shown?.launchReceipt?.structuredAttach.providerProcessIncarnationSha256).toBe(
      shown?.provider?.processIncarnationSha256
    )
    const revision = shown?.revision
    const replayed = reopened.recordCodexLabRuntimeLaunchReceipt({
      ...harness.identity,
      receipt
    })
    expect(replayed.revision).toBe(revision)
    expect(replayed.launchReceipt).toEqual(receipt)
  })

  it('rejects re-digested nested launch-receipt forgeries', () => {
    const harness = createHarness()
    const attached = advanceTo(harness, 'provider_attached')
    const valid = launchReceipt(harness, attached)
    const forgedStableReceipts = [
      { ...valid, profilePolicySha256: 'f'.repeat(64), receiptSha256: undefined },
      {
        ...valid,
        generatedHome: { ...valid.generatedHome, attestedContractSha256: 'f'.repeat(64) },
        receiptSha256: undefined
      },
      {
        ...valid,
        generatedHome: { ...valid.generatedHome, attestedToolContractSha256: 'f'.repeat(64) },
        receiptSha256: undefined
      },
      {
        ...valid,
        worktree: {
          ...valid.worktree,
          digests: { ...valid.worktree.digests, selectorSha256: 'f'.repeat(64) }
        },
        receiptSha256: undefined
      },
      {
        ...valid,
        structuredAttach: { ...valid.structuredAttach, appServerAttestation: 'forged' },
        receiptSha256: undefined
      }
    ]
    for (const { receiptSha256: _receiptSha256, ...stable } of forgedStableReceipts) {
      const forged = { ...stable, receiptSha256: sha256(JSON.stringify(stable)) }
      expect(() => parseCodexLabLaunchReceipt(forged, harness.dispatchId)).toThrow()
    }
  })

  it('makes exact transition retries idempotent and refuses skips, backwards moves and evidence drift', () => {
    const harness = createHarness()
    const planned = plan(harness)
    const plannedAgain = plan(harness)
    expect(plannedAgain.revision).toBe(planned.revision)

    expect(() =>
      harness.db.recordCodexLabRuntimeLayoutPrepared({
        ...harness.identity,
        runtimeParentIdentity: { device: '1', inode: '2' },
        runtimeRootIdentity: { device: '1', inode: '3' },
        configSha256: 'e'.repeat(64)
      })
    ).toThrow('expected authority_attached, not planned')

    const attached = harness.db.recordCodexLabRuntimeAuthorityAttached(harness.identity)
    expect(harness.db.recordCodexLabRuntimeAuthorityAttached(harness.identity).revision).toBe(
      attached.revision
    )
    const layout = harness.db.recordCodexLabRuntimeLayoutPrepared({
      ...harness.identity,
      runtimeParentIdentity: { device: '1', inode: '2' },
      runtimeRootIdentity: { device: '1', inode: '3' },
      configSha256: 'e'.repeat(64)
    })
    expect(
      harness.db.recordCodexLabRuntimeLayoutPrepared({
        ...harness.identity,
        runtimeParentIdentity: { device: '1', inode: '2' },
        runtimeRootIdentity: { device: '1', inode: '3' },
        configSha256: 'e'.repeat(64)
      }).revision
    ).toBe(layout.revision)
    expect(() =>
      harness.db.recordCodexLabRuntimeLayoutPrepared({
        ...harness.identity,
        runtimeParentIdentity: { device: '9', inode: '2' },
        runtimeRootIdentity: { device: '1', inode: '3' },
        configSha256: 'e'.repeat(64)
      })
    ).toThrow('different evidence')
    expect(() => harness.db.recordCodexLabRuntimeAuthorityAttached(harness.identity)).toThrow(
      'expected planned, not layout_prepared'
    )
    expect(() => plan(harness)).toThrow('expected planned, not layout_prepared')
    expect(() =>
      harness.db.recordCodexLabRuntimeExternalAuthInstalled({
        dispatchId: harness.dispatchId,
        profileId: 'another-profile',
        authMethod: 'chatgptAuthTokens',
        authStorage: 'ephemeral',
        loginStartAccepted: true,
        authJsonAbsent: true
      })
    ).toThrow('profile does not match')
  })

  it('requires provider reservation, then gateway, then external auth before provider attachment', () => {
    const harness = createHarness()
    advanceTo(harness, 'layout_prepared')

    expect(() =>
      harness.db.recordCodexLabRuntimeGatewayStarted({
        ...harness.identity,
        receipt: gatewayReceipt(harness)
      })
    ).toThrow('provider identity does not match the gateway receipt')

    const reserved = harness.db.recordCodexLabRuntimeProviderReserved(providerEvidence(harness))
    expect(reserved).toMatchObject({
      state: 'provider_reserved',
      provider: {
        terminalHandleSha256: sha256(TERMINAL_HANDLE),
        terminalPaneKeySha256: sha256(TERMINAL_PANE_KEY),
        processIncarnationSha256: sha256(PROCESS_INCARNATION)
      },
      cleanup: { provider: { state: 'pending' } }
    })
    expect(
      harness.db.recordCodexLabRuntimeProviderReserved(providerEvidence(harness)).revision
    ).toBe(reserved.revision)

    expect(() =>
      harness.db.recordCodexLabRuntimeExternalAuthInstalled({
        ...harness.identity,
        authMethod: 'chatgptAuthTokens',
        authStorage: 'ephemeral',
        loginStartAccepted: true,
        authJsonAbsent: true
      })
    ).toThrow('expected gateway_started, not provider_reserved')

    const gateway = harness.db.recordCodexLabRuntimeGatewayStarted({
      ...harness.identity,
      receipt: gatewayReceipt(harness)
    })
    expect(gateway).toMatchObject({
      state: 'gateway_started',
      cleanup: {
        gateway: { state: 'pending' },
        auth: { state: 'not_created' }
      }
    })
    expect(
      harness.db.recordCodexLabRuntimeGatewayStarted({
        ...harness.identity,
        receipt: gatewayReceipt(harness)
      }).revision
    ).toBe(gateway.revision)
    expect(() =>
      harness.db.recordCodexLabRuntimeProviderAttached(providerEvidence(harness))
    ).toThrow('expected external_auth_installed, not gateway_started')

    const authenticated = harness.db.recordCodexLabRuntimeExternalAuthInstalled({
      ...harness.identity,
      authMethod: 'chatgptAuthTokens',
      authStorage: 'ephemeral',
      loginStartAccepted: true,
      authJsonAbsent: true
    })
    expect(
      harness.db.recordCodexLabRuntimeExternalAuthInstalled({
        ...harness.identity,
        authMethod: 'chatgptAuthTokens',
        authStorage: 'ephemeral',
        loginStartAccepted: true,
        authJsonAbsent: true
      }).revision
    ).toBe(authenticated.revision)
    expect(authenticated).toMatchObject({
      state: 'external_auth_installed',
      auth: {
        method: 'chatgptAuthTokens',
        storage: 'ephemeral',
        loginStartAccepted: true,
        authJsonAbsent: true
      }
    })

    const attached = harness.db.recordCodexLabRuntimeProviderAttached(providerEvidence(harness))
    expect(attached.state).toBe('provider_attached')
    expect(
      harness.db.recordCodexLabRuntimeProviderAttached(providerEvidence(harness)).revision
    ).toBe(attached.revision)
  })

  it('snapshots public evidence once and rejects accessors, symbols and extra fields', () => {
    const harness = createHarness()
    let getterCalls = 0
    const accessorPlan = {
      get dispatchId() {
        getterCalls += 1
        return harness.dispatchId
      },
      profileId: PROFILE_ID,
      runtimeRoot: expectedCodexLabDispatchRuntimeRoot(harness.dispatchId)
    }
    expect(() => harness.db.planCodexLabRuntimeCustody(accessorPlan)).toThrow(
      'must use data fields'
    )
    expect(getterCalls).toBe(0)

    const symbol = Symbol('forged')
    const symbolPlan = {
      ...harness.identity,
      runtimeRoot: expectedCodexLabDispatchRuntimeRoot(harness.dispatchId),
      [symbol]: 'unexpected'
    }
    expect(() => harness.db.planCodexLabRuntimeCustody(symbolPlan)).toThrow('fields are invalid')

    const extraPlan = {
      ...harness.identity,
      runtimeRoot: expectedCodexLabDispatchRuntimeRoot(harness.dispatchId),
      unexpected: 'field'
    }
    expect(() => harness.db.planCodexLabRuntimeCustody(extraPlan)).toThrow('fields are invalid')
  })

  it('refuses to advance launch custody after the worker Dispatch settles', () => {
    const harness = createHarness()
    plan(harness)
    harness.db.failWorkerStart(harness.dispatchId, 'lab_runtime_planned', 'injected failure')

    expect(() => harness.db.recordCodexLabRuntimeAuthorityAttached(harness.identity)).toThrow(
      'launch custody is no longer active'
    )
  })

  it('rejects secret-like, extra and corrupted JSON gateway evidence', () => {
    const harness = createHarness()
    advanceTo(harness, 'provider_reserved')
    const forgedDigest = Object.freeze({
      ...gatewayReceipt(harness),
      receiptSha256: '0'.repeat(64)
    })
    expect(() =>
      harness.db.recordCodexLabRuntimeGatewayStarted({
        ...harness.identity,
        receipt: forgedDigest
      })
    ).toThrow('gateway receipt digest is invalid')
    const poisoned = Object.freeze({
      ...gatewayReceipt(harness),
      bearer: 'Bearer should-never-be-durable'
    })
    expect(() =>
      harness.db.recordCodexLabRuntimeGatewayStarted({
        ...harness.identity,
        receipt: poisoned
      })
    ).toThrow('gateway receipt fields are invalid')

    harness.db.recordCodexLabRuntimeGatewayStarted({
      ...harness.identity,
      receipt: gatewayReceipt(harness)
    })
    harness.db.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET gateway_public_receipt = ? WHERE dispatch_id = ?`
      )
      .run(
        JSON.stringify({ ...gatewayReceipt(harness), authorization: 'dcap_stolen' }),
        harness.dispatchId
      )
    expect(() => harness.db.getCodexLabRuntimeCustody(harness.dispatchId)).toThrow(
      'gateway receipt fields are invalid'
    )
  })

  it.each([
    'planned',
    'authority_attached',
    'layout_prepared',
    'provider_reserved',
    'gateway_started',
    'external_auth_installed',
    'provider_attached',
    'ready'
  ] as const)('resumes cleanup from %s without inventing uncreated obligations', (phase) => {
    const harness = createHarness(`cleanup from ${phase}`)
    advanceTo(harness, phase)
    const pending = harness.db.beginCodexLabRuntimeCleanup(harness.identity)
    expect(pending.state).toBe('cleanup_pending')
    proveCreatedResourcesReleased(harness)
    const released = harness.db.releaseCodexLabRuntimeCustody(harness.identity)
    expect(released.state).toBe('released')
    expect(
      JSON.parse(harness.db.getWorkerDispatch(harness.dispatchId)?.residual_resources ?? '')
    ).toEqual([])
  })

  it('retains the aggregate residual and N=1 lease until every cleanup obligation is proven', () => {
    const harness = createHarness()
    advanceTo(harness, 'ready')
    harness.db.failWorkerStart(harness.dispatchId, 'provider_attached', 'injected launch failure')
    harness.db.beginCodexLabRuntimeCleanup(harness.identity)
    harness.db.recordCodexLabRuntimeCleanupResult({
      ...harness.identity,
      resource: 'gateway',
      outcome: 'failed',
      reasonCode: 'release_failed',
      detailSha256: sha256('private host diagnostic')
    })

    const blocked = harness.db.getCodexLabRuntimeCustody(harness.dispatchId)
    expect(blocked?.cleanup.gateway).toEqual({
      state: 'failed',
      reasonCode: 'release_failed',
      detailSha256: sha256('private host diagnostic')
    })
    expect(harness.db.getWorkerDispatch(harness.dispatchId)?.residual_resources).toBe(
      JSON.stringify([{ kind: 'created_lab_runtime', id: harness.dispatchId }])
    )
    expect(() => harness.db.releaseCodexLabRuntimeCustody(harness.identity)).toThrow(
      'cleanup is not proven'
    )
    expect(() =>
      harness.db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'must remain profile fenced',
        taskRunId: 'run_legacy_local',
        startOptions: { profile: { id: PROFILE_ID } },
        profileLease: { profileId: PROFILE_ID }
      })
    ).toThrow('unresolved cleanup')

    harness.db.recordCodexLabRuntimeCleanupResult({
      ...harness.identity,
      resource: 'gateway',
      outcome: 'released'
    })
    harness.db.recordCodexLabRuntimeCleanupResult({
      ...harness.identity,
      resource: 'provider',
      outcome: 'unproven',
      reasonCode: 'process_exit_unproven'
    })
    expect(() =>
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource: 'auth',
        outcome: 'released'
      })
    ).toThrow('external auth requires proven provider exit')
    expect(() =>
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource: 'provider',
        outcome: 'released'
      })
    ).toThrow('provider exit is not proven')
    proveCreatedResourcesReleased(harness)
    const released = harness.db.releaseCodexLabRuntimeCustody(harness.identity)
    const replayed = harness.db.releaseCodexLabRuntimeCustody(harness.identity)
    expect(replayed.revision).toBe(released.revision)

    const next = harness.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskSpec: 'profile capacity restored',
      taskRunId: 'run_legacy_local',
      startOptions: { profile: { id: PROFILE_ID } },
      profileLease: { profileId: PROFILE_ID }
    })
    expect(next.dispatch.id).not.toBe(harness.dispatchId)
  })

  it('rejects caller-fabricated exit claims and trusts only the released canonical resource', () => {
    const harness = createHarness()
    advanceTo(harness, 'ready')
    harness.db.failWorkerStart(harness.dispatchId, 'provider_attached', 'cleanup requested')
    harness.db.beginCodexLabRuntimeCleanup(harness.identity)

    const forged = {
      ...harness.identity,
      resource: 'provider' as const,
      outcome: 'released' as const,
      providerExit: {
        verdict: 'exited',
        sessionId: SESSION_ID,
        terminalHandle: TERMINAL_HANDLE,
        terminalPaneKey: TERMINAL_PANE_KEY,
        processIncarnation: PROCESS_INCARNATION
      }
    }
    expect(() => harness.db.recordCodexLabRuntimeCleanupResult(forged)).toThrow(
      'cleanup result fields are invalid'
    )
    expect(() =>
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource: 'provider',
        outcome: 'released'
      })
    ).toThrow('provider exit is not proven')

    const requested = harness.db.requestWorkerTerminalRelease(harness.dispatchId)
    expect(requested.disposition).toBe('requested')
    if (requested.disposition !== 'requested') {
      throw new Error('provider resource was not releaseable')
    }
    harness.db.settleWorkerTerminalRelease(requested.resource.id)
    expect(
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource: 'provider',
        outcome: 'released'
      }).cleanup.provider.state
    ).toBe('released')
  })

  it('allows early gateway revocation but releases layout only after provider, auth and gateway', () => {
    const harness = createHarness()
    advanceTo(harness, 'ready')
    harness.db.failWorkerStart(harness.dispatchId, 'provider_attached', 'cleanup requested')
    harness.db.beginCodexLabRuntimeCleanup(harness.identity)

    expect(
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource: 'gateway',
        outcome: 'released'
      }).cleanup.gateway.state
    ).toBe('released')
    expect(() =>
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource: 'layout',
        outcome: 'released'
      })
    ).toThrow('layout cleanup must be released last')
    expect(() =>
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource: 'auth',
        outcome: 'released'
      })
    ).toThrow('external auth requires proven provider exit')
  })

  it('persists only fixed cleanup reason codes and optional detail digests', () => {
    const harness = createHarness()
    advanceTo(harness, 'planned')
    harness.db.beginCodexLabRuntimeCleanup(harness.identity)

    const rawError = {
      ...harness.identity,
      resource: 'layout' as const,
      outcome: 'failed' as const,
      reasonCode: 'release_failed' as const,
      error: 'Bearer plaintext must never be durable'
    }
    expect(() => harness.db.recordCodexLabRuntimeCleanupResult(rawError)).toThrow(
      'cleanup result fields are invalid'
    )
    const invalidReason = {
      ...harness.identity,
      resource: 'layout',
      outcome: 'failed',
      reasonCode: 'arbitrary caller text'
    }
    expect(() =>
      Reflect.apply(harness.db.recordCodexLabRuntimeCleanupResult, harness.db, [invalidReason])
    ).toThrow('cleanup reason code is invalid')
    expect(JSON.stringify(harness.db.getCodexLabRuntimeCustody(harness.dispatchId))).not.toContain(
      'Bearer plaintext'
    )
  })

  it('prevents every worker write path from clearing unresolved aggregate custody', () => {
    const harness = createHarness()
    advanceTo(harness, 'planned')
    harness.db.failWorkerStart(harness.dispatchId, 'lab_runtime_planned', 'cleanup requested')
    harness.db.beginCodexLabRuntimeCleanup(harness.identity)

    expect(() =>
      harness.db.db
        .prepare('UPDATE worker_dispatches SET residual_resources = ? WHERE dispatch_id = ?')
        .run('[]', harness.dispatchId)
    ).toThrow('aggregate custody forbids residual mutation')
    expect(() =>
      harness.db.recordWorkerStage({
        dispatchId: harness.dispatchId,
        stage: 'attempted_bypass',
        residualResources: []
      })
    ).toThrow('aggregate custody forbids residual mutation')
    expect(harness.db.getWorkerDispatch(harness.dispatchId)?.residual_resources).toBe(
      JSON.stringify([{ kind: 'created_lab_runtime', id: harness.dispatchId }])
    )
    expect(() =>
      harness.db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'must remain fenced after bypass',
        taskRunId: 'run_legacy_local',
        startOptions: { profile: { id: PROFILE_ID } },
        profileLease: { profileId: PROFILE_ID }
      })
    ).toThrow('unresolved cleanup')
  })

  it('rolls back the released state when aggregate residual clearing fails in the transaction', () => {
    const harness = createHarness()
    advanceTo(harness, 'planned')
    harness.db.beginCodexLabRuntimeCleanup(harness.identity)
    harness.db.db.exec(`
      CREATE TRIGGER reject_lab_residual_clear
      BEFORE UPDATE OF residual_resources ON worker_dispatches
      WHEN OLD.dispatch_id = '${harness.dispatchId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected residual clear failure');
      END;
    `)

    expect(() => harness.db.releaseCodexLabRuntimeCustody(harness.identity)).toThrow(
      'injected residual clear failure'
    )
    expect(harness.db.getCodexLabRuntimeCustody(harness.dispatchId)?.state).toBe('cleanup_pending')
    expect(harness.db.getWorkerDispatch(harness.dispatchId)?.residual_resources).toBe(
      JSON.stringify([{ kind: 'created_lab_runtime', id: harness.dispatchId }])
    )
  })

  it('refuses task and global resets while a recovery custody record is unreleased', () => {
    const harness = createHarness()
    advanceTo(harness, 'planned')
    harness.db.failWorkerStart(harness.dispatchId, 'lab_runtime_planned', 'cleanup requested')
    harness.db.beginCodexLabRuntimeCleanup(harness.identity)

    expect(() => harness.db.resetTasks()).toThrow('recovery record is unreleased')
    expect(() => harness.db.resetAll()).toThrow('recovery record is unreleased')
    expect(harness.db.getCodexLabRuntimeCustody(harness.dispatchId)?.state).toBe('cleanup_pending')
    expect(harness.db.getWorkerDispatch(harness.dispatchId)?.dispatch_id).toBe(harness.dispatchId)
  })

  it('migrates a v41 database to the durable custody schema', () => {
    const db = new OrchestrationDb(':memory:')
    trackDatabase(db)
    db.db.exec('DROP TABLE codex_lab_runtime_custody')
    db.db.pragma('user_version = 41')

    db.migrate()

    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('codex_lab_runtime_custody')
    ).toEqual({ name: 'codex_lab_runtime_custody' })
  })
})
