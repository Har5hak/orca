import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { OrchestrationDb } from '../../db'
import { LAB_GATEWAY_ALLOWED_OPERATIONS } from '../../lab-profile/dispatch-gateway-policy-contract'
import type {
  CodexLabGatewayPublicReceipt,
  CodexLabRuntimeCustodyState
} from './lab-runtime-custody-contract'
import { expectedCodexLabDispatchRuntimeRoot, sha256 } from './lab-runtime-custody-validation'

const PROFILE_ID = 'lab-readonly-supervised-v1'
const PROVIDER_ID = 'codex-workspace-chatgpt-v1'
const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const TERMINAL_HANDLE = 'structworker_33333333-3333-4333-8333-333333333333'
const TERMINAL_PANE_KEY = `agent-session-${SESSION_ID}:22222222-2222-4222-8222-222222222222`
const PROCESS_INCARNATION = `structured:${SESSION_ID}`
const CLEANUP_RESOURCES = ['provider', 'gateway', 'auth', 'layout'] as const

type Harness = Readonly<{
  db: OrchestrationDb
  dispatchId: string
  identity: Readonly<{ dispatchId: string; profileId: string }>
}>

const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function createHarness(spec = 'persist Codex lab runtime custody'): Harness {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskSpec: spec,
    taskRunId: 'run_legacy_local',
    startOptions: { profile: { id: PROFILE_ID } },
    profileLease: { profileId: PROFILE_ID }
  })
  const dispatchId = started.dispatch.id
  db.recordWorkerStage({
    dispatchId,
    stage: 'lab_runtime_planned',
    effects: [{ kind: 'created_lab_runtime', id: dispatchId }],
    residualResources: [{ kind: 'created_lab_runtime', id: dispatchId }]
  })
  db.prepareStartingWorkerAuthority({
    dispatchId,
    handle: TERMINAL_HANDLE,
    paneKey: TERMINAL_PANE_KEY,
    processIncarnation: PROCESS_INCARNATION,
    worktreeId: 'lab-test-worktree',
    effects: [{ kind: 'created_lab_runtime', id: dispatchId }],
    setupState: 'lab_runtime_planned',
    preserveCreatedLabRuntimeResidual: true
  })
  return {
    db,
    dispatchId,
    identity: Object.freeze({ dispatchId, profileId: PROFILE_ID })
  }
}

function providerEvidence(harness: Harness) {
  return Object.freeze({
    ...harness.identity,
    providerId: PROVIDER_ID,
    sessionId: SESSION_ID,
    terminalHandle: TERMINAL_HANDLE,
    terminalPaneKey: TERMINAL_PANE_KEY,
    processIncarnation: PROCESS_INCARNATION
  })
}

function plan(harness: Harness) {
  return harness.db.planCodexLabRuntimeCustody({
    ...harness.identity,
    runtimeRoot: expectedCodexLabDispatchRuntimeRoot(harness.dispatchId)
  })
}

function gatewayReceipt(dispatchId: string): CodexLabGatewayPublicReceipt {
  const endpointIdentity = Object.freeze({
    device: '16777234',
    inode: '9001',
    uid: '501',
    mode: '0600' as const,
    type: 'socket' as const
  })
  const stable = Object.freeze({
    schema: 'orca.lab-dispatch-gateway.v1',
    policyId: 'lgp1_public-policy-receipt',
    dispatchId,
    transport: 'unix',
    socketMode: '0600',
    endpointSha256: sha256(join(expectedCodexLabDispatchRuntimeRoot(dispatchId), 'gateway.sock')),
    endpointIdentity,
    endpointIdentitySha256: sha256(JSON.stringify(endpointIdentity)),
    processIncarnationSha256: sha256(`structured:${SESSION_ID}`),
    allowedOperations: LAB_GATEWAY_ALLOWED_OPERATIONS,
    lifecycleSource: 'injected-per-request',
    dcapCustody: 'server-only'
  } as const)
  return Object.freeze({
    schema: stable.schema,
    policyId: stable.policyId,
    dispatchId: stable.dispatchId,
    transport: stable.transport,
    socketMode: stable.socketMode,
    endpointSha256: stable.endpointSha256,
    endpointIdentity: stable.endpointIdentity,
    endpointIdentitySha256: stable.endpointIdentitySha256,
    processIncarnationSha256: stable.processIncarnationSha256,
    allowedOperations: stable.allowedOperations,
    lifecycleSource: stable.lifecycleSource,
    receiptSha256: sha256(JSON.stringify(stable))
  })
}

function advanceTo(
  harness: Harness,
  target: Exclude<CodexLabRuntimeCustodyState, 'cleanup_pending' | 'released'>
) {
  let custody = plan(harness)
  if (target === 'planned') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeAuthorityAttached(harness.identity)
  if (target === 'authority_attached') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeLayoutPrepared({
    ...harness.identity,
    runtimeParentIdentity: { device: '1', inode: '2' },
    runtimeRootIdentity: { device: '1', inode: '3' },
    configSha256: 'e'.repeat(64)
  })
  if (target === 'layout_prepared') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeProviderReserved(providerEvidence(harness))
  if (target === 'provider_reserved') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeGatewayStarted({
    ...harness.identity,
    receipt: gatewayReceipt(harness.dispatchId)
  })
  if (target === 'gateway_started') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeExternalAuthInstalled({
    ...harness.identity,
    authMethod: 'chatgptAuthTokens',
    authStorage: 'ephemeral',
    loginStartAccepted: true,
    authJsonAbsent: true
  })
  if (target === 'external_auth_installed') {
    return custody
  }
  custody = harness.db.recordCodexLabRuntimeProviderAttached(providerEvidence(harness))
  if (target === 'provider_attached') {
    return custody
  }
  return harness.db.recordCodexLabRuntimeReady(harness.identity)
}

function proveCreatedResourcesReleased(harness: Harness): void {
  let custody = harness.db.getCodexLabRuntimeCustody(harness.dispatchId)
  if (!custody) {
    throw new Error('missing custody row')
  }
  if (custody.cleanup.provider.state !== 'not_created') {
    const worker = harness.db.getWorkerDispatch(harness.dispatchId)
    if (worker?.state === 'starting') {
      harness.db.failWorkerStart(harness.dispatchId, worker.stage, 'cleanup test settlement')
    }
    const requested = harness.db.requestWorkerTerminalRelease(harness.dispatchId)
    if (requested.disposition === 'requested') {
      harness.db.settleWorkerTerminalRelease(requested.resource.id)
    }
  }
  for (const resource of CLEANUP_RESOURCES) {
    if (custody.cleanup[resource].state !== 'not_created') {
      harness.db.recordCodexLabRuntimeCleanupResult({
        ...harness.identity,
        resource,
        outcome: 'released'
      })
    }
    custody = harness.db.getCodexLabRuntimeCustody(harness.dispatchId) ?? custody
  }
}

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
      configSha256: 'e'.repeat(64),
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
      revision: 7
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
        receipt: gatewayReceipt(harness.dispatchId)
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
      receipt: gatewayReceipt(harness.dispatchId)
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
        receipt: gatewayReceipt(harness.dispatchId)
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
      ...gatewayReceipt(harness.dispatchId),
      receiptSha256: '0'.repeat(64)
    })
    expect(() =>
      harness.db.recordCodexLabRuntimeGatewayStarted({
        ...harness.identity,
        receipt: forgedDigest
      })
    ).toThrow('gateway receipt digest is invalid')
    const poisoned = Object.freeze({
      ...gatewayReceipt(harness.dispatchId),
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
      receipt: gatewayReceipt(harness.dispatchId)
    })
    harness.db.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET gateway_public_receipt = ? WHERE dispatch_id = ?`
      )
      .run(
        JSON.stringify({ ...gatewayReceipt(harness.dispatchId), authorization: 'dcap_stolen' }),
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
    databases.push(db)
    db.db.exec('DROP TABLE codex_lab_runtime_custody')
    db.db.pragma('user_version = 41')

    db.migrate()

    expect(db.db.pragma('user_version', { simple: true })).toBe(42)
    expect(
      db.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('codex_lab_runtime_custody')
    ).toEqual({ name: 'codex_lab_runtime_custody' })
  })
})
