import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexLabLaunchFacts,
  SealedCodexLabLaunchPlan
} from '../../../../orchestration/lab-profile/codex-lab-launch-contract'
import type { CodexLabHostReadinessReceipt } from '../../../../orchestration/lab-profile/codex-lab-command-confinement-live-contract'
import { testCodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import { buildLabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server-receipt'
import type {
  CodexLabRuntimeLayoutHost,
  PreparedCodexLabRuntimeLayout
} from '../../../../orchestration/lab-profile/codex-lab-runtime-layout'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import {
  prepareLocalCodexLabLaunchAuthority,
  type LocalCodexLabLaunchAuthorityDeps
} from './local-codex-lab-launch-authority'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import {
  closeContinuationDatabases,
  harness
} from './local-lab-worker-start-continuation.test-support'
import {
  LocalLabLaunchAuthorityPreparationRefusal,
  type LocalLabLaunchLifecycleRecorder
} from './local-lab-launch-authority-contract'
import { codexLabCapacityPolicy } from '../../../../orchestration/lab-profile/codex-lab-usage-authorization'

const WORKSPACE_ID = '018f47a2-9d72-7cc1-b046-7a2868411f42'
const bindingFixture = testCodexLabStructuredLaunchBinding()
const WORKTREE_PATH = bindingFixture.worktree.observation.path
const GATEWAY_CREDENTIAL = `lgw1_${'a'.repeat(43)}`
const IDENTITY: StructuredWorkerIdentity = Object.freeze({
  handle: 'structworker_33333333-3333-4333-8333-333333333333',
  sessionId: '11111111-1111-4111-8111-111111111111',
  agent: 'codex',
  paneKey:
    'agent-session-11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  processIncarnation: 'structured:11111111-1111-4111-8111-111111111111',
  worktreeId: 'repo::disposable-structured',
  hostScope: Object.freeze({ kind: 'local', hostId: 'local' })
})

afterEach(() => {
  closeContinuationDatabases()
  vi.restoreAllMocks()
})

function prepared(): PreparedLocalLabWorkerStart {
  return harness(bindingFixture).prepared
}

function launchFacts(preparedStart: PreparedLocalLabWorkerStart): CodexLabLaunchFacts {
  const dispatchId = preparedStart.started.dispatch.id
  return {
    platform: 'darwin',
    profile: 'lab-readonly-supervised-v1',
    adapter: 'codex-workspace-chatgpt-v1',
    dispatch: {
      id: dispatchId,
      runtimeRoot: '/private/tmp/orca-lab/runtime',
      codexHomeState: 'absent',
      fakeHomeState: 'absent'
    },
    worktree: {
      identity: bindingFixture.worktree.observation.worktreeIdentity,
      expectedPath: WORKTREE_PATH,
      observedPath: WORKTREE_PATH,
      observedRealPath: WORKTREE_PATH,
      kind: 'directory',
      disposable: true
    },
    gateway: { socketPath: gatewayEndpoint(dispatchId), credential: GATEWAY_CREDENTIAL },
    binary: {
      path: '/Applications/ChatGPT.app/Contents/Resources/codex',
      observedRealPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      kind: 'regular-file',
      executable: true,
      pinnedSha256: 'a'.repeat(64),
      observedSha256: 'a'.repeat(64)
    },
    authentication: {
      loginMethod: 'chatgpt',
      expectedWorkspaceId: WORKSPACE_ID,
      observedWorkspaceId: WORKSPACE_ID,
      subscription: {
        status: 'active',
        scope: 'workspace',
        unambiguous: true,
        planType: 'team'
      },
      capacityPolicy: codexLabCapacityPolicy({
        workspaceId: WORKSPACE_ID,
        planType: 'team',
        authorization: null
      }),
      authJson: { state: 'absent' }
    },
    ambientEnv: {}
  }
}

function gatewayReceipt(dispatchId: string) {
  const evidence = Object.freeze({
    device: '1',
    inode: '4',
    uid: '501',
    mode: '0600' as const,
    type: 'socket' as const
  })
  return buildLabGatewayServerReceipt(
    gatewayEndpoint(dispatchId),
    IDENTITY.processIncarnation,
    'lgp1_authority757',
    dispatchId,
    { evidence, identitySha256: sha256(JSON.stringify(evidence)) }
  )
}

function layout(dispatchId: string, configSha256: string): PreparedCodexLabRuntimeLayout {
  const root = `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}`
  return {
    schemaVersion: 1,
    dispatchId,
    dispatchesRootIdentity: { device: '1', inode: '1' },
    dispatchRoot: root,
    dispatchRootIdentity: { device: '1', inode: '2' },
    codexHome: `${root}/codex-home`,
    codexHomeIdentity: { device: '1', inode: '3' },
    fakeHome: `${root}/fake-home`,
    fakeHomeIdentity: { device: '1', inode: '4' },
    configPath: `${root}/codex-home/config.toml`,
    configIdentity: { device: '1', inode: '5' },
    configSha256
  }
}

function deps(
  events: string[],
  preparedStart: PreparedLocalLabWorkerStart,
  rollback = vi.fn(() => true)
): LocalCodexLabLaunchAuthorityDeps {
  const dispatchId = preparedStart.started.dispatch.id
  const endpoint = gatewayEndpoint(dispatchId)
  const receipt = gatewayReceipt(dispatchId)
  return {
    createGateway: () => ({
      endpoint,
      credential: GATEWAY_CREDENTIAL,
      start: async () => {
        events.push('gateway:start')
        return receipt
      },
      stop: async () => {
        events.push('gateway:stop')
      }
    }),
    prepareCredential: async ({ dispatchId, sessionId }) => {
      events.push('auth:read')
      return {
        metadata: { workspaceId: WORKSPACE_ID, planType: 'team' },
        register: () => {
          events.push('auth:register')
          return {
            binding: { dispatchId, sessionId, workspaceId: WORKSPACE_ID },
            metadata: { workspaceId: WORKSPACE_ID, planType: 'team' },
            rollbackIfUnclaimed: rollback
          }
        }
      }
    },
    collectLaunchFacts: async () => {
      events.push('facts')
      return launchFacts(preparedStart)
    },
    layoutHost: unusedLayoutHost(),
    prepareLayout: async (plan) => {
      events.push('layout:prepare')
      return {
        ok: true,
        prepared: layout(dispatchId, plan.receiptInputs.configSha256),
        rollback: []
      }
    },
    verifyLaunch: async ({ plan, preparedLayout }) => {
      events.push('confinement:verify')
      return { plan, preparedLayout, receipt: readinessReceipt(plan, preparedLayout) }
    },
    removeLayout: async () => {
      events.push('layout:remove')
      return {
        evidence: 'identity-fenced-active-layout-revoked',
        quarantinePath: `/private/tmp/orca-lab/runtime/dispatches/.${dispatchId}.cleanup-quarantine`,
        rootIdentity: { device: '1', inode: '2' }
      }
    }
  }
}

function gatewayEndpoint(dispatchId: string): string {
  return `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}/gateway.sock`
}

function unusedLayoutHost(): CodexLabRuntimeLayoutHost {
  const unavailable = async (): Promise<never> => {
    throw new Error('Layout host mechanics are replaced by the launch-authority fixture.')
  }
  return {
    observePath: unavailable,
    makeDirectoryExclusive: unavailable,
    writeFileExclusive: unavailable,
    sha256File: unavailable,
    removeTree: unavailable
  }
}

function readinessReceipt(
  plan: SealedCodexLabLaunchPlan,
  preparedLayout: PreparedCodexLabRuntimeLayout
): CodexLabHostReadinessReceipt {
  return Object.freeze({
    schema: 'orca.codex-lab-host-readiness.v1',
    dispatchId: plan.dispatchId,
    profile: plan.profile,
    adapter: plan.adapter,
    worktreeIdentity: plan.worktreeIdentity,
    worktreePath: plan.cwd,
    codexExecutableSha256: plan.codexExecutableSha256,
    configSha256: preparedLayout.configSha256,
    probeExecutablePath: '/bin/sh',
    probeExecutableSha256: 'b'.repeat(64),
    probeSourceSha256: 'c'.repeat(64),
    controlsSha256: 'd'.repeat(64),
    probeReportSha256: 'e'.repeat(64),
    exactSandboxSpecSha256: 'f'.repeat(64),
    controlTrust: 'trusted-local-host',
    probeIdentityTrust: 'host-re-attested',
    dispatchChannel: 'exact-unix-socket-permitted',
    arbitraryNetwork: 'denied',
    forbiddenWrites: 'denied',
    worktreeRead: 'verified',
    processTreeTermination: 'verified',
    appServerAttestation: 'required-at-opened-thread-gate',
    receiptSha256: '0'.repeat(64)
  })
}

function lifecycle(events: string[]): LocalLabLaunchLifecycleRecorder {
  return {
    recordLayoutPrepared: () => events.push('custody:layout'),
    recordProviderReserved: () => events.push('custody:provider-reserved'),
    recordGatewayStarted: () => events.push('custody:gateway')
  }
}

async function capturePreparationRefusal(
  launch: Promise<unknown>
): Promise<LocalLabLaunchAuthorityPreparationRefusal> {
  try {
    await launch
  } catch (error) {
    if (error instanceof LocalLabLaunchAuthorityPreparationRefusal) {
      return error
    }
    throw error
  }
  throw new Error('Expected laboratory authority preparation to refuse.')
}

describe('local Codex laboratory launch authority', () => {
  it('composes gateway, auth, sealed plan, layout and verified confinement before binding', async () => {
    const events: string[] = []
    const preparedStart = prepared()
    const authority = await prepareLocalCodexLabLaunchAuthority({
      prepared: preparedStart,
      identity: IDENTITY,
      dispatchCapability: `dcap_${'b'.repeat(43)}`,
      lifecycle: lifecycle(events),
      deps: deps(events, preparedStart)
    })

    expect(events).toEqual([
      'auth:read',
      'facts',
      'layout:prepare',
      'custody:layout',
      'custody:provider-reserved',
      'confinement:verify',
      'gateway:start',
      'custody:gateway',
      'auth:register'
    ])
    expect(authority.labLaunchBinding).toMatchObject({
      dispatchId: preparedStart.started.dispatch.id,
      plan: { enforcedWorkspaceId: WORKSPACE_ID, cwd: WORKTREE_PATH },
      worktree: bindingFixture.worktree
    })
    expect(authority.layoutEvidence).toEqual({
      dispatchId: preparedStart.started.dispatch.id,
      profileId: 'lab-readonly-supervised-v1',
      runtimeParentIdentity: { device: '1', inode: '1' },
      runtimeRootIdentity: { device: '1', inode: '2' },
      configSha256: authority.labLaunchBinding.plan.receiptInputs.configSha256
    })
    expect(authority.gatewayReceipt).not.toHaveProperty('dcapCustody')
    await expect(authority.rollbackIfUnclaimed()).resolves.toBe(true)
    expect(authority.releaseCleanupRegistration()).toBe(true)
  })

  it('rolls back unclaimed auth before gateway and layout cleanup', async () => {
    const events: string[] = []
    const preparedStart = prepared()
    const rollback = vi.fn(() => {
      events.push('auth:rollback')
      return true
    })
    const authority = await prepareLocalCodexLabLaunchAuthority({
      prepared: preparedStart,
      identity: IDENTITY,
      dispatchCapability: `dcap_${'b'.repeat(43)}`,
      lifecycle: lifecycle(events),
      deps: deps(events, preparedStart, rollback)
    })

    await expect(authority.rollbackIfUnclaimed()).resolves.toBe(true)
    expect(events.slice(-3)).toEqual(['auth:rollback', 'gateway:stop', 'layout:remove'])
    expect(authority.releaseCleanupRegistration()).toBe(true)
  })

  it('retries only the host cleanup step that did not prove release', async () => {
    const events: string[] = []
    const preparedStart = prepared()
    const dispatchId = preparedStart.started.dispatch.id
    const rollback = vi.fn(() => {
      events.push('auth:rollback')
      return true
    })
    const composed = deps(events, preparedStart, rollback)
    const removeLayout = vi
      .fn()
      .mockRejectedValueOnce(new Error('injected layout busy'))
      .mockResolvedValue({
        evidence: 'identity-fenced-active-layout-revoked',
        quarantinePath: `/private/tmp/orca-lab/runtime/dispatches/.${dispatchId}.cleanup-quarantine`,
        rootIdentity: { device: '1', inode: '2' }
      })
    const authority = await prepareLocalCodexLabLaunchAuthority({
      prepared: preparedStart,
      identity: IDENTITY,
      dispatchCapability: `dcap_${'b'.repeat(43)}`,
      lifecycle: lifecycle(events),
      deps: { ...composed, removeLayout }
    })

    await expect(authority.rollbackIfUnclaimed()).rejects.toThrow('host rollback remains pending')
    await expect(authority.rollbackIfUnclaimed()).resolves.toBe(true)
    expect(rollback).toHaveBeenCalledOnce()
    expect(events.filter((event) => event === 'gateway:stop')).toHaveLength(1)
    expect(removeLayout).toHaveBeenCalledTimes(2)
    expect(authority.releaseCleanupRegistration()).toBe(true)
  })

  it('retains gateway and layout when auth authority was already claimed', async () => {
    const events: string[] = []
    const preparedStart = prepared()
    const authority = await prepareLocalCodexLabLaunchAuthority({
      prepared: preparedStart,
      identity: IDENTITY,
      dispatchCapability: `dcap_${'b'.repeat(43)}`,
      lifecycle: lifecycle(events),
      deps: deps(
        events,
        preparedStart,
        vi.fn(() => false)
      )
    })

    await expect(authority.rollbackIfUnclaimed()).resolves.toBe(false)
    expect(events).not.toContain('gateway:stop')
    expect(events).not.toContain('layout:remove')
    expect(authority.releaseCleanupRegistration()).toBe(true)
  })

  it('proves confinement before publishing gateway or auth authority', async () => {
    const events: string[] = []
    const preparedStart = prepared()
    const composed = deps(events, preparedStart)
    const refusing: LocalCodexLabLaunchAuthorityDeps = {
      ...composed,
      verifyLaunch: async () => {
        events.push('confinement:refuse')
        throw new Error('injected confinement refusal')
      }
    }

    const refusal = await capturePreparationRefusal(
      prepareLocalCodexLabLaunchAuthority({
        prepared: preparedStart,
        identity: IDENTITY,
        dispatchCapability: `dcap_${'b'.repeat(43)}`,
        lifecycle: lifecycle(events),
        deps: refusing
      })
    )
    expect(refusal.message).toContain('injected confinement refusal')
    expect(refusal.releaseCleanupRegistration?.()).toBe(true)
    expect(events.at(-1)).toBe('layout:remove')
    expect(events).not.toContain('gateway:start')
    expect(events).not.toContain('gateway:stop')
    expect(events).not.toContain('auth:register')
  })

  it('refuses self-consistent facts that do not belong to the admitted dispatch', async () => {
    const events: string[] = []
    const preparedStart = prepared()
    const composed = deps(events, preparedStart)
    const mismatched: LocalCodexLabLaunchAuthorityDeps = {
      ...composed,
      collectLaunchFacts: async () => ({
        ...launchFacts(preparedStart),
        dispatch: { ...launchFacts(preparedStart).dispatch, id: 'ctx_different_authority' }
      })
    }

    const refusal = await capturePreparationRefusal(
      prepareLocalCodexLabLaunchAuthority({
        prepared: preparedStart,
        identity: IDENTITY,
        dispatchCapability: `dcap_${'b'.repeat(43)}`,
        lifecycle: lifecycle(events),
        deps: mismatched
      })
    )
    expect(refusal.message).toMatch(/do not match admitted launch authority/i)
    expect(refusal.releaseCleanupRegistration?.()).toBe(true)
    expect(events).not.toContain('gateway:start')
    expect(events).not.toContain('auth:register')
  })

  it('contains cleanup-authority identity validation as a clean pre-preparation refusal', async () => {
    const events: string[] = []
    const preparedStart = prepared()
    const refusal = await capturePreparationRefusal(
      prepareLocalCodexLabLaunchAuthority({
        prepared: preparedStart,
        identity: {
          ...IDENTITY,
          processIncarnation: 'structured:22222222-2222-4222-8222-222222222222'
        },
        dispatchCapability: `dcap_${'b'.repeat(43)}`,
        lifecycle: lifecycle(events),
        deps: deps(events, preparedStart)
      })
    )

    expect(refusal).toMatchObject({
      cleanupProven: true,
      message: 'Codex laboratory runtime cleanup authority conflicts or is invalid.'
    })
    expect(refusal.releaseCleanupRegistration).toBeUndefined()
    expect(events).toEqual([])
  })

  it('contains cleanup-authority conflicts without disturbing the registered authority', async () => {
    const preparedStart = prepared()
    const registeredEvents: string[] = []
    const registered = await prepareLocalCodexLabLaunchAuthority({
      prepared: preparedStart,
      identity: IDENTITY,
      dispatchCapability: `dcap_${'b'.repeat(43)}`,
      lifecycle: lifecycle(registeredEvents),
      deps: deps(registeredEvents, preparedStart)
    })

    try {
      const refusedEvents: string[] = []
      const refusal = await capturePreparationRefusal(
        prepareLocalCodexLabLaunchAuthority({
          prepared: preparedStart,
          identity: IDENTITY,
          dispatchCapability: `dcap_${'c'.repeat(43)}`,
          lifecycle: lifecycle(refusedEvents),
          deps: deps(refusedEvents, preparedStart)
        })
      )

      expect(refusal).toMatchObject({
        cleanupProven: true,
        message: 'Codex laboratory runtime cleanup authority conflicts or is invalid.'
      })
      expect(refusal.releaseCleanupRegistration).toBeUndefined()
      expect(refusedEvents).toEqual([])
    } finally {
      await expect(registered.rollbackIfUnclaimed()).resolves.toBe(true)
      expect(registered.releaseCleanupRegistration()).toBe(true)
    }
  })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
