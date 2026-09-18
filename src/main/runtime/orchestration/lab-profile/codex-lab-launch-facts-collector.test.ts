import { afterEach, describe, expect, it, vi } from 'vitest'
import { testCodexLabStructuredLaunchBinding } from './codex-lab-structured-launch-binding-test-support'
import { buildSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  collectCodexLabLaunchFacts,
  type CodexLabLaunchFactsCollectorHost
} from './codex-lab-launch-facts-collector'
import { mintCodexLabUsageAuthorization } from './codex-lab-usage-authorization'
import type { PreparedLocalLabWorkerStart } from '../../rpc/methods/orchestration/worker/local-lab-worker-start'
import {
  closeContinuationDatabases,
  harness as createPreparedStartHarness
} from '../../rpc/methods/orchestration/worker/local-lab-worker-start-continuation.test-support'

const SHA = 'a'.repeat(64)
const WORKSPACE = '018f47a2-9d72-7cc1-b046-7a2868411f42'
const binding = testCodexLabStructuredLaunchBinding()

function prepared(): PreparedLocalLabWorkerStart {
  return createPreparedStartHarness(binding).prepared
}

afterEach(() => {
  closeContinuationDatabases()
  vi.restoreAllMocks()
})

function host(present = new Set<string>()): CodexLabLaunchFactsCollectorHost {
  return {
    platform: 'darwin',
    observeExecutable: (path) => ({
      path,
      observedRealPath: path,
      kind: 'regular-file',
      executable: true,
      identity: { device: '1', inode: '2' },
      sha256: SHA
    }),
    observePath: (path) => (present.has(path) ? 'present' : 'absent')
  }
}

describe('Codex laboratory launch facts collector', () => {
  it('binds fresh host facts to the admitted worktree, credential and gateway', () => {
    const preparedStart = prepared()
    const dispatchId = preparedStart.started.dispatch.id
    const facts = collectCodexLabLaunchFacts({
      prepared: preparedStart,
      gateway: {
        endpoint: `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}/gateway.sock`,
        credential: `lgw1_${'b'.repeat(43)}`
      },
      credential: { workspaceId: WORKSPACE, planType: 'business' },
      usageAuthorization: null,
      executable: {
        path: '/Applications/ChatGPT.app/Contents/Resources/codex',
        pinnedSha256: SHA
      },
      host: host()
    })

    expect(buildSealedCodexLabLaunchPlan(facts)).toMatchObject({
      dispatchId,
      cwd: binding.worktree.observation.realpath,
      enforcedWorkspaceId: WORKSPACE,
      codexExecutableSha256: SHA
    })
  })

  it('reports a target auth file as present so sealing fails closed', () => {
    const preparedStart = prepared()
    const dispatchId = preparedStart.started.dispatch.id
    const authPath = `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}/codex-home/auth.json`
    const facts = collectCodexLabLaunchFacts({
      prepared: preparedStart,
      gateway: {
        endpoint: `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}/gateway.sock`,
        credential: `lgw1_${'b'.repeat(43)}`
      },
      credential: { workspaceId: WORKSPACE, planType: 'business' },
      usageAuthorization: null,
      executable: {
        path: '/Applications/ChatGPT.app/Contents/Resources/codex',
        pinnedSha256: SHA
      },
      host: host(new Set([authPath]))
    })

    expect(() => buildSealedCodexLabLaunchPlan(facts)).toThrow(
      expect.objectContaining({
        data: { reason: 'auth_json_forbidden', field: 'authentication.authJson' }
      })
    )
  })

  it.each(['self_serve_business_usage_based', 'enterprise_cbp_usage_based'])(
    'refuses the metered workspace plan %s before provider spawn',
    (planType) => {
      const preparedStart = prepared()
      const dispatchId = preparedStart.started.dispatch.id
      const facts = collectCodexLabLaunchFacts({
        prepared: preparedStart,
        gateway: {
          endpoint: `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}/gateway.sock`,
          credential: `lgw1_${'b'.repeat(43)}`
        },
        credential: { workspaceId: WORKSPACE, planType },
        usageAuthorization: null,
        executable: {
          path: '/Applications/ChatGPT.app/Contents/Resources/codex',
          pinnedSha256: SHA
        },
        host: host()
      })

      expect(() => buildSealedCodexLabLaunchPlan(facts)).toThrow(
        expect.objectContaining({
          data: { reason: 'paid_usage_forbidden', field: 'authentication.subscription' }
        })
      )
    }
  )

  it('seals an exact unexpired Run authorization for the selected metered workspace', () => {
    const preparedStart = prepared()
    const dispatchId = preparedStart.started.dispatch.id
    const authorization = mintCodexLabUsageAuthorization({
      workspaceId: WORKSPACE,
      planType: 'enterprise_cbp_usage_based',
      expiresAt: '2099-09-24T23:00:00.000Z',
      nowMs: 0
    })
    const facts = collectCodexLabLaunchFacts({
      prepared: preparedStart,
      gateway: {
        endpoint: `/private/tmp/orca-lab/runtime/dispatches/${dispatchId}/gateway.sock`,
        credential: `lgw1_${'b'.repeat(43)}`
      },
      credential: { workspaceId: WORKSPACE, planType: 'enterprise_cbp_usage_based' },
      usageAuthorization: authorization,
      executable: {
        path: '/Applications/ChatGPT.app/Contents/Resources/codex',
        pinnedSha256: SHA
      },
      host: host()
    })

    expect(buildSealedCodexLabLaunchPlan(facts)).toMatchObject({
      capacityPolicy: {
        route: 'authorized-metered-workspace',
        workspaceIdSha256: authorization.workspaceIdSha256,
        planType: 'enterprise_cbp_usage_based',
        expiresAt: authorization.expiresAt
      },
      receiptInputs: { capacityPolicy: 'authorized-metered-workspace' }
    })
  })
})
