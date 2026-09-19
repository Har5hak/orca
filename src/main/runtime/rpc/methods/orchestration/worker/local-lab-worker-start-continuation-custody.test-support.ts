import { join } from 'node:path'
import { vi } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type {
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyState
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-contract'
import {
  expectedCodexLabDispatchRuntimeRoot,
  sha256
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-validation'
import { buildLabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server-receipt'
import { createLabGatewayPolicyReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-policy'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { publicCodexLabGatewayReceipt } from './local-codex-lab-gateway-public-receipt'

type CustodyFixtureContext = Readonly<{
  profile: 'lab-readonly-supervised-v1'
  identity: Readonly<StructuredWorkerIdentity>
  configSha256ForDispatch(dispatchId: string): string
}>

export function stubCodexLabCustodyTransitions(input: {
  db: OrchestrationDb
  events: string[]
  context: CustodyFixtureContext
}): void {
  const { db, events, context } = input
  vi.spyOn(db, 'planCodexLabRuntimeCustody').mockImplementation((transition) => {
    events.push('custody:planned')
    return custodyFixture(transition.dispatchId, 'planned', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeAuthorityAttached').mockImplementation((transition) => {
    events.push('custody:authority')
    return custodyFixture(transition.dispatchId, 'authority_attached', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeLayoutPrepared').mockImplementation((transition) => {
    events.push('custody:layout')
    return custodyFixture(transition.dispatchId, 'layout_prepared', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeProviderReserved').mockImplementation((transition) => {
    events.push('custody:provider-reserved')
    return custodyFixture(transition.dispatchId, 'provider_reserved', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeGatewayStarted').mockImplementation((transition) => {
    events.push('custody:gateway')
    return custodyFixture(transition.dispatchId, 'gateway_started', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeExternalAuthInstalled').mockImplementation((transition) => {
    events.push('custody:auth')
    return custodyFixture(transition.dispatchId, 'external_auth_installed', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeProviderAttached').mockImplementation((transition) => {
    events.push('custody:provider')
    return custodyFixture(transition.dispatchId, 'provider_attached', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeLaunchReceipt').mockImplementation((transition) => {
    events.push('custody:receipt')
    return custodyFixture(transition.dispatchId, 'provider_attached', context)
  })
  vi.spyOn(db, 'recordCodexLabRuntimeReady').mockImplementation((transition) => {
    events.push('custody:ready')
    return custodyFixture(transition.dispatchId, 'ready', context)
  })
}

export function stubCodexLabGatewayReceipt(
  dispatchId: string,
  identity: Readonly<StructuredWorkerIdentity>
) {
  const endpointIdentity = Object.freeze({
    device: '1',
    inode: '4',
    uid: '501',
    mode: '0600' as const,
    type: 'socket' as const
  })
  return publicCodexLabGatewayReceipt(
    buildLabGatewayServerReceipt(
      join(expectedCodexLabDispatchRuntimeRoot(dispatchId), 'gateway.sock'),
      identity.processIncarnation,
      'lgp1_continuation-test',
      dispatchId,
      {
        evidence: endpointIdentity,
        identitySha256: sha256(JSON.stringify(endpointIdentity))
      },
      createLabGatewayPolicyReceipt({
        schemaVersion: 1,
        policyId: 'lgp1_continuation-test',
        credentialSha256: 'a'.repeat(64),
        binding: {
          runId: 'run_task_757',
          taskId: 'task_task_757',
          dispatchId,
          terminalHandle: identity.handle,
          terminalPaneKey: identity.paneKey
        },
        revoked: false,
        workerDoneAccepted: false,
        terminal: false
      })
    )
  )
}

function custodyFixture(
  dispatchId: string,
  state: CodexLabRuntimeCustodyState,
  context: CustodyFixtureContext
): CodexLabRuntimeCustody {
  const absentCleanup = Object.freeze({
    state: 'not_created' as const,
    reasonCode: null,
    detailSha256: null
  })
  const pendingCleanup = Object.freeze({
    state: 'pending' as const,
    reasonCode: null,
    detailSha256: null
  })
  const states: readonly CodexLabRuntimeCustodyState[] = [
    'planned',
    'authority_attached',
    'layout_prepared',
    'provider_reserved',
    'gateway_started',
    'external_auth_installed',
    'provider_attached',
    'ready',
    'cleanup_pending',
    'released'
  ]
  const level = states.indexOf(state)
  const layoutCreated = level >= states.indexOf('layout_prepared')
  const providerCreated = level >= states.indexOf('provider_reserved')
  const gatewayCreated = level >= states.indexOf('gateway_started')
  const authCreated = level >= states.indexOf('external_auth_installed')
  return Object.freeze({
    dispatchId,
    profileId: context.profile,
    state,
    runtimeRoot: join('/private/tmp/orca-lab/runtime/dispatches', dispatchId),
    runtimeParentIdentity: layoutCreated ? { device: '1', inode: '2' } : null,
    runtimeRootIdentity: layoutCreated ? { device: '1', inode: '3' } : null,
    configSha256: layoutCreated ? context.configSha256ForDispatch(dispatchId) : null,
    auth: authCreated
      ? Object.freeze({
          method: 'chatgptAuthTokens' as const,
          storage: 'ephemeral' as const,
          loginStartAccepted: true as const,
          authJsonAbsent: true as const
        })
      : null,
    gatewayReceipt: gatewayCreated
      ? stubCodexLabGatewayReceipt(dispatchId, context.identity)
      : null,
    launchReceipt: null,
    provider: providerCreated
      ? Object.freeze({
          id: 'codex-workspace-chatgpt-v1' as const,
          terminalResourceId: 'wtr_11111111-1111-4111-8111-111111111111',
          sessionSha256: sha256(context.identity.sessionId),
          terminalHandleSha256: sha256(context.identity.handle),
          terminalPaneKeySha256: sha256(context.identity.paneKey),
          processIncarnationSha256: sha256(context.identity.processIncarnation)
        })
      : null,
    cleanup: Object.freeze({
      layout: layoutCreated ? pendingCleanup : absentCleanup,
      auth: authCreated ? pendingCleanup : absentCleanup,
      gateway: gatewayCreated ? pendingCleanup : absentCleanup,
      provider: providerCreated ? pendingCleanup : absentCleanup
    }),
    revision: 0,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z'
  })
}
