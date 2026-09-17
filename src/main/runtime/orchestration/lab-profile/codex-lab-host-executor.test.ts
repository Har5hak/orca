import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_LAB_ACTUAL_HOST_GAPS,
  executeSealedCodexLabHostPlan
} from './codex-lab-host-executor'
import { FakeCodexLabHost, sealedHostPlan } from './codex-lab-host-fake.test-support'

describe('sealed Codex laboratory host executor', () => {
  it('creates and verifies a fresh secure layout before an exact no-shell spawn', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.message)
    }
    const dispatchRoot = dirname(plan.runtimePaths.codexHome)
    expect(host.calls).toEqual([
      `observe:${dispatchRoot}`,
      `mkdir:${dispatchRoot}:700`,
      `mkdir:${plan.runtimePaths.codexHome}:700`,
      `mkdir:${plan.runtimePaths.fakeHome}:700`,
      `write:${host.configPath()}:600`,
      `observe:${dispatchRoot}`,
      `observe:${plan.runtimePaths.codexHome}`,
      `observe:${plan.runtimePaths.fakeHome}`,
      `observe:${host.configPath()}`,
      `sha256:${host.configPath()}`,
      'probe-effective',
      'spawn',
      'probe-runtime'
    ])
    expect(host.fileContents.get(host.configPath())).toBe(plan.configToml)
    expect(host.effectiveProbeRequests).toEqual([
      {
        executable: plan.executable,
        argv: plan.argv,
        cwd: plan.cwd,
        env: plan.environment.injected,
        configPath: host.configPath(),
        shell: false,
        network: false,
        providerSession: false
      }
    ])
    expect(host.spawnRequests).toEqual([
      {
        executable: plan.executable,
        argv: plan.argv,
        cwd: plan.cwd,
        env: plan.environment.injected,
        shell: false
      }
    ])
    expect(result.receipt).toMatchObject({
      dispatchId: plan.dispatchId,
      processId: 'fake-process-757',
      configPath: host.configPath(),
      configSha256: plan.receiptInputs.configSha256,
      actualHostGaps: CODEX_LAB_ACTUAL_HOST_GAPS,
      observations: {
        filesystem: { state: 'verified' },
        network: { state: 'verified' },
        provider: { state: 'verified' }
      }
    })
    expect(result.rollback).toEqual([])
  })

  it('refuses a pre-existing Dispatch root without modifying it', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    host.setExistingDispatchRoot()

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result).toMatchObject({
      ok: false,
      stage: 'freshness',
      reason: 'dispatch_root_not_fresh',
      rollback: []
    })
    expect(host.calls).toEqual([`observe:${dirname(plan.runtimePaths.codexHome)}`])
  })

  it('verifies the written config digest before probing or spawning', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    host.configDigestOverride = 'b'.repeat(64)

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result).toMatchObject({
      ok: false,
      stage: 'verify_config_digest',
      reason: 'config_digest_mismatch'
    })
    expect(host.calls).not.toContain('probe-effective')
    expect(host.calls).not.toContain('spawn')
    expect(result.rollback).toEqual([
      expect.objectContaining({ order: 1, action: 'remove_dispatch_root', status: 'succeeded' })
    ])
  })

  it('fails closed when the effective tool inventory is broader than the exact policy', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    if (host.effectivePolicy.state !== 'verified') {
      throw new Error('fake effective policy must start verified')
    }
    host.effectivePolicy = {
      ...host.effectivePolicy,
      evidence: {
        ...host.effectivePolicy.evidence,
        toolInventory: [...host.effectivePolicy.evidence.toolInventory, 'computer']
      }
    }

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result).toMatchObject({
      ok: false,
      stage: 'probe_effective_policy',
      reason: 'effective_policy_mismatch'
    })
    expect(host.calls).not.toContain('spawn')
  })

  it('does not promote an unverified effective-policy observation', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    host.effectivePolicy = { state: 'unverified', reason: 'probe unavailable' }

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result).toMatchObject({
      ok: false,
      stage: 'probe_effective_policy',
      reason: 'effective_policy_unverified',
      effectivePolicy: { state: 'unverified', reason: 'probe unavailable' }
    })
    expect(host.calls).not.toContain('spawn')
  })

  it('fails closed when any created path is not observed at its exact secure mode', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const originalObserve = host.observePath.bind(host)
    host.observePath = async (path) => {
      const observation = await originalObserve(path)
      return path === plan.runtimePaths.codexHome && observation.kind === 'directory'
        ? { ...observation, mode: 0o755 }
        : observation
    }

    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result).toMatchObject({
      ok: false,
      stage: 'verify_layout',
      reason: 'layout_verification_failed'
    })
    expect(host.calls).not.toContain('spawn')
  })
})
