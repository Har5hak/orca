import { describe, expect, it } from 'vitest'
import { executeSealedCodexLabHostPlan } from './codex-lab-host-executor'
import { FakeCodexLabHost, sealedHostPlan } from './codex-lab-host-fake.test-support'

describe('sealed Codex laboratory host rollback', () => {
  it('removes the Dispatch root when spawn refuses before returning a process', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    host.failOperations.add('spawn')

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result).toMatchObject({ ok: false, stage: 'spawn', reason: 'host_operation_failed' })
    expect(result.rollback).toEqual([
      expect.objectContaining({ order: 1, action: 'remove_dispatch_root', status: 'succeeded' })
    ])
  })

  it.each(['filesystem', 'network', 'provider'] as const)(
    'rolls back and preserves an unverified %s observation after spawn',
    async (boundary) => {
      const plan = sealedHostPlan()
      const host = new FakeCodexLabHost(plan)
      host.runtimeObservations = {
        ...host.runtimeObservations,
        [boundary]: { state: 'unverified', reason: `${boundary} probe unavailable` }
      }

      const result = await executeSealedCodexLabHostPlan(plan, host)

      expect(result).toMatchObject({
        ok: false,
        stage: 'probe_runtime_boundaries',
        reason: 'runtime_observation_unverified',
        observations: {
          [boundary]: { state: 'unverified', reason: `${boundary} probe unavailable` }
        }
      })
      expect(result.rollback).toEqual([
        expect.objectContaining({ order: 1, action: 'terminate_process', status: 'succeeded' }),
        expect.objectContaining({ order: 2, action: 'remove_dispatch_root', status: 'succeeded' })
      ])
    }
  )

  it('rejects verified-looking runtime evidence that does not exactly match the plan', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    if (host.runtimeObservations.network.state !== 'verified') {
      throw new Error('fake network observation must start verified')
    }
    host.runtimeObservations = {
      ...host.runtimeObservations,
      network: {
        state: 'verified',
        evidence: {
          ...host.runtimeObservations.network.evidence,
          toolEgress: 'allowed'
        }
      }
    }

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result).toMatchObject({
      ok: false,
      stage: 'probe_runtime_boundaries',
      reason: 'runtime_observation_mismatch'
    })
    expect(result.rollback.map((step) => step.action)).toEqual([
      'terminate_process',
      'remove_dispatch_root'
    ])
  })

  it('does not remove evidence when process termination is unconfirmed', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    host.runtimeObservations = {
      ...host.runtimeObservations,
      provider: { state: 'unverified', reason: 'provider attestation absent' }
    }
    host.failOperations.add('terminate')

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result.rollback).toEqual([
      expect.objectContaining({ order: 1, action: 'terminate_process', status: 'failed' }),
      expect.objectContaining({
        order: 2,
        action: 'remove_dispatch_root',
        status: 'skipped'
      })
    ])
    expect(host.calls.some((call) => call.startsWith('remove-tree:'))).toBe(false)
  })

  it('records a failed root removal instead of hiding incomplete rollback', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    host.configDigestOverride = 'b'.repeat(64)
    host.failOperations.add('remove-tree')

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result.rollback).toEqual([
      expect.objectContaining({ order: 1, action: 'remove_dispatch_root', status: 'failed' })
    ])
  })
})
