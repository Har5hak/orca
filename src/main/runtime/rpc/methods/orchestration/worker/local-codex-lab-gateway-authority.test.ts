import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_LAB_RUNTIME_ROOT } from '../../../../orchestration/lab-profile/codex-lab-launch-contract'
import { testCodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import {
  createLabGatewayPolicyReceipt,
  type LabGatewayPolicy
} from '../../../../orchestration/lab-profile/dispatch-gateway-policy'
import { buildLabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server-receipt'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import {
  createLocalCodexLabGatewayAuthority,
  type LocalCodexLabGatewayAuthorityHost
} from './local-codex-lab-gateway-authority'
import {
  closeContinuationDatabases,
  harness
} from './local-lab-worker-start-continuation.test-support'

afterEach(() => {
  closeContinuationDatabases()
  vi.restoreAllMocks()
})

describe('local Codex laboratory gateway authority', () => {
  it('binds one inert gateway to the exact admitted Dispatch and delegates explicit start/stop', async () => {
    const bindingFixture = testCodexLabStructuredLaunchBinding()
    const world = harness(bindingFixture)
    const { db, prepared, runtime } = world
    const dispatchId = prepared.started.dispatch.id
    const endpoint = `${CODEX_LAB_RUNTIME_ROOT}/dispatches/${dispatchId}/gateway.sock`
    const identity = Object.freeze({
      handle: 'structworker_gateway_authority',
      sessionId: 'session_gateway_authority',
      agent: 'codex',
      paneKey: 'tab_gateway:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'structured:session_gateway_authority',
      worktreeId: 'worktree_gateway_authority',
      hostScope: Object.freeze({ kind: 'local', hostId: 'local' })
    }) satisfies StructuredWorkerIdentity
    const policy = Object.freeze({
      schemaVersion: 1,
      policyId: 'lgp1_gateway_authority',
      credentialSha256: 'a'.repeat(64),
      binding: Object.freeze({
        runId: prepared.started.dispatch.run_id,
        taskId: prepared.started.dispatch.task_id,
        dispatchId,
        terminalHandle: identity.handle,
        terminalPaneKey: identity.paneKey
      }),
      revoked: false,
      workerDoneAccepted: false,
      terminal: false
    }) satisfies LabGatewayPolicy
    const evidence = Object.freeze({
      device: '1',
      inode: '4',
      uid: '501',
      mode: '0600' as const,
      type: 'socket' as const
    })
    const receipt = buildLabGatewayServerReceipt(
      endpoint,
      identity.processIncarnation,
      policy.policyId,
      dispatchId,
      {
        evidence,
        identitySha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
      },
      createLabGatewayPolicyReceipt(policy)
    )
    const start = vi.fn(async () => receipt)
    const stop = vi.fn(async () => undefined)
    const resolveLifecycle = vi.fn(async () => null)
    const invokeRpc = vi.fn(async () => null)
    const createServer = vi.fn(() => ({ start, stop }))
    const createLifecycleResolver = vi.fn(() => resolveLifecycle)
    const createRpcInvoker = vi.fn(() => invokeRpc)
    const mintPolicy = vi.fn(() => ({ credential: 'lgw1_process_local', policy }))
    const host: LocalCodexLabGatewayAuthorityHost = Object.freeze({
      mintPolicy,
      createLifecycleResolver,
      createRpcInvoker,
      createServer
    })
    const authority = createLocalCodexLabGatewayAuthority(
      {
        prepared,
        identity,
        dispatchCapability: `dcap_${'c'.repeat(43)}`,
        runtime,
        db
      },
      host
    )

    expect(start).not.toHaveBeenCalled()
    expect(mintPolicy).toHaveBeenCalledWith(policy.binding)
    expect(createLifecycleResolver).toHaveBeenCalledWith({
      db,
      runtimeEpoch: 'runtime_task_757',
      profileId: prepared.admission.profile
    })
    expect(createRpcInvoker).toHaveBeenCalledWith(runtime)
    expect(createServer).toHaveBeenCalledWith({
      endpoint,
      policy,
      processIncarnation: identity.processIncarnation,
      dispatchCapability: `dcap_${'c'.repeat(43)}`,
      resolveLifecycle,
      invokeRpc
    })
    expect(authority.endpoint).toBe(endpoint)
    expect(authority.credential).toBe('lgw1_process_local')
    await expect(authority.start()).resolves.toBe(receipt)
    await expect(authority.stop()).resolves.toBeUndefined()
    expect(start).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })
})
