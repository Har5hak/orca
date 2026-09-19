import { afterEach, describe, expect, it, vi } from 'vitest'
import { testCodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import { continuePreparedLocalLabWorkerStart } from './local-lab-worker-start-continuation'
import type { LocalLabWorkerContinuationDeps } from './local-lab-worker-start-continuation-contract'
import { exposeCodexLabRuntimeCustody } from './worker-observation'
import {
  closeContinuationDatabases,
  harness,
  IDENTITY,
  realPhaseAuthority,
  structuredSessionFixture
} from './local-lab-worker-start-continuation.test-support'
import { stubCodexLabCustodyTransitions } from './local-lab-worker-start-continuation-custody.test-support'

afterEach(() => {
  closeContinuationDatabases()
})

describe('local laboratory worker launch receipt', () => {
  it('returns the exact secret-free receipt exposed by worker-show after durable persistence', async () => {
    const { db, runtime, run, prepared } = harness(testCodexLabStructuredLaunchBinding())
    const binding = testCodexLabStructuredLaunchBinding({
      dispatchId: prepared.started.dispatch.id
    })
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async ({ lifecycle }) => {
        const authority = realPhaseAuthority(prepared, binding)
        lifecycle.recordLayoutPrepared(authority.layoutEvidence)
        lifecycle.recordProviderReserved()
        lifecycle.recordGatewayStarted(authority.gatewayReceipt)
        return authority
      },
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        return structuredSessionFixture()
      },
      deliverPreamble: async () => {
        expect(db.getCodexLabRuntimeCustody(prepared.started.dispatch.id)?.launchReceipt).not.toBe(
          null
        )
      },
      tearDownFailedStart: vi.fn(async () => undefined)
    }

    const result = await continuePreparedLocalLabWorkerStart({
      prepared,
      runtime,
      db,
      run,
      coordinatorHandle: 'term_coord',
      deps
    })
    if (!result || typeof result !== 'object') {
      throw new Error('expected worker-start result')
    }
    const startReceipt = Reflect.get(result, 'launchReceipt')
    const shown = exposeCodexLabRuntimeCustody(db, prepared.started.dispatch.id)
    expect(shown?.launchReceipt).toEqual(startReceipt)
    expect(JSON.stringify(startReceipt)).not.toMatch(
      /(?:lgw1_|dcap_|bearer\s|gatewayAccessSha256|authorization|credential|secret|token)/iu
    )
  })

  it('does not compose a receipt or preamble when structured app-server attestation refuses', async () => {
    const { db, runtime, run, prepared } = harness(testCodexLabStructuredLaunchBinding())
    const binding = testCodexLabStructuredLaunchBinding({
      dispatchId: prepared.started.dispatch.id
    })
    stubCodexLabCustodyTransitions({
      db,
      events: [],
      context: {
        profile: 'lab-readonly-supervised-v1',
        identity: IDENTITY,
        configSha256ForDispatch: () => binding.plan.receiptInputs.configSha256
      }
    })
    const buildLaunchReceipt = vi.fn(() => {
      throw new Error('launch receipt must not be composed before attach')
    })
    const deliverPreamble = vi.fn(async () => undefined)
    const deps: LocalLabWorkerContinuationDeps = {
      prepareLaunchAuthority: async ({ lifecycle }) => {
        const authority = realPhaseAuthority(prepared, binding)
        lifecycle.recordLayoutPrepared(authority.layoutEvidence)
        lifecycle.recordProviderReserved()
        lifecycle.recordGatewayStarted(authority.gatewayReceipt)
        return authority
      },
      createStructuredSession: async (args) => {
        if (!args.beforeAttach) {
          throw new Error('laboratory beforeAttach callback missing')
        }
        await args.beforeAttach(IDENTITY)
        throw new Error('structured app-server attestation mismatch')
      },
      buildLaunchReceipt,
      deliverPreamble,
      tearDownFailedStart: vi.fn(async () => undefined)
    }

    await expect(
      continuePreparedLocalLabWorkerStart({
        prepared,
        runtime,
        db,
        run,
        coordinatorHandle: 'term_coord',
        deps
      })
    ).resolves.toMatchObject({
      state: 'failed',
      failedStage: 'provider_attach',
      lastError: 'structured app-server attestation mismatch'
    })
    expect(buildLaunchReceipt).not.toHaveBeenCalled()
    expect(deliverPreamble).not.toHaveBeenCalled()
  })
})
