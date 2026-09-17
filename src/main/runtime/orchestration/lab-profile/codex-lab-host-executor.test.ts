import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CODEX_LAB_ACTUAL_HOST_GAPS,
  attestSealedCodexLabProviderAcquisition,
  type CodexLabPreparationHost,
  type CodexLabProviderAttestationHost,
  prepareSealedCodexLabHostPlan,
  executeSealedCodexLabHostPlan
} from './codex-lab-host-executor'
import { FakeCodexLabHost, sealedHostPlan } from './codex-lab-host-fake.test-support'

describe('sealed Codex laboratory host executor', () => {
  it('prepares and attests the secure layout without access to a spawn seam', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const preparationHost: CodexLabPreparationHost = {
      observePath: (path) => host.observePath(path),
      makeDirectoryExclusive: (path, mode, parent) =>
        host.makeDirectoryExclusive(path, mode, parent),
      writeFileExclusive: (path, contents, mode, parent) =>
        host.writeFileExclusive(path, contents, mode, parent),
      sha256File: (path, identity) => host.sha256File(path, identity),
      probeEffectivePolicy: (request) => host.probeEffectivePolicy(request),
      removeTree: (path, rootIdentity, parentIdentity) =>
        host.removeTree(path, rootIdentity, parentIdentity)
    }

    const result = await prepareSealedCodexLabHostPlan(plan, preparationHost)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.message)
    }
    expect(host.calls).toEqual([
      'observe:/private',
      'observe:/private/tmp',
      'observe:/private',
      'observe:/private/tmp/orca-lab',
      'mkdir:/private/tmp/orca-lab:700',
      'observe:/private/tmp',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'mkdir:/private/tmp/orca-lab/runtime:700',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      'mkdir:/private/tmp/orca-lab/runtime/dispatches:700',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `observe:${dirname(plan.runtimePaths.codexHome)}`,
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `mkdir:${dirname(plan.runtimePaths.codexHome)}:700`,
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `mkdir:${plan.runtimePaths.codexHome}:700`,
      `mkdir:${plan.runtimePaths.fakeHome}:700`,
      `write:${host.configPath()}:600`,
      'observe:/private',
      'observe:/private/tmp',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `observe:${dirname(plan.runtimePaths.codexHome)}`,
      `observe:${plan.runtimePaths.codexHome}`,
      `observe:${plan.runtimePaths.fakeHome}`,
      `observe:${host.configPath()}`,
      `sha256:${host.configPath()}`,
      `observe:${host.configPath()}`,
      `observe:${dirname(plan.runtimePaths.codexHome)}`,
      'probe-effective'
    ])
    expect(host.spawnRequests).toEqual([])
    expect(host.runtimeProbeRequests).toEqual([])
    expect(host.fileContents.get(host.configPath())).toBe(plan.configToml)
    expect(result.prepared).toMatchObject({
      dispatchId: plan.dispatchId,
      dispatchRoot: dirname(plan.runtimePaths.codexHome),
      configPath: host.configPath(),
      configSha256: plan.receiptInputs.configSha256
    })
  })

  it('attests one supplied structured provider identity without access to a spawn seam', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const preparation = await prepareSealedCodexLabHostPlan(plan, host)
    if (!preparation.ok) {
      throw new Error(preparation.message)
    }
    host.calls.length = 0
    const attestationHost: CodexLabProviderAttestationHost = {
      probeRuntimeBoundaries: (request) => host.probeRuntimeBoundaries(request),
      terminateProcess: (processId) => host.terminateProcess(processId),
      removeTree: (path, rootIdentity, parentIdentity) =>
        host.removeTree(path, rootIdentity, parentIdentity)
    }

    const result = await attestSealedCodexLabProviderAcquisition(
      plan,
      preparation.prepared,
      { processId: 'fake-process-757' },
      attestationHost
    )

    expect(result.ok).toBe(true)
    expect(host.calls).toEqual(['probe-runtime'])
    expect(host.spawnRequests).toEqual([])
    expect(host.runtimeProbeRequests).toEqual([
      {
        processId: 'fake-process-757',
        dispatchRoot: dirname(plan.runtimePaths.codexHome),
        configPath: host.configPath(),
        worktreePath: plan.cwd
      }
    ])
  })

  it('refuses a mismatched preparation without probing, spawning, or deleting a path', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const preparation = await prepareSealedCodexLabHostPlan(plan, host)
    if (!preparation.ok) {
      throw new Error(preparation.message)
    }
    host.calls.length = 0

    const result = await attestSealedCodexLabProviderAcquisition(
      plan,
      { ...preparation.prepared, dispatchId: 'different-dispatch' },
      { processId: 'fake-process-757' },
      host
    )

    expect(result).toMatchObject({
      ok: false,
      stage: 'validate_acquisition',
      reason: 'preparation_mismatch',
      rollback: []
    })
    expect(host.calls).toEqual([])
    expect(host.spawnRequests).toEqual([])
  })

  it('composes exactly one injected no-shell spawn between preparation and attestation', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const result = await executeSealedCodexLabHostPlan(plan, host)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.message)
    }
    const dispatchRoot = dirname(plan.runtimePaths.codexHome)
    expect(host.calls).toEqual([
      'observe:/private',
      'observe:/private/tmp',
      'observe:/private',
      'observe:/private/tmp/orca-lab',
      'mkdir:/private/tmp/orca-lab:700',
      'observe:/private/tmp',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'mkdir:/private/tmp/orca-lab/runtime:700',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      'mkdir:/private/tmp/orca-lab/runtime/dispatches:700',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `observe:${dispatchRoot}`,
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `mkdir:${dispatchRoot}:700`,
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `mkdir:${plan.runtimePaths.codexHome}:700`,
      `mkdir:${plan.runtimePaths.fakeHome}:700`,
      `write:${host.configPath()}:600`,
      'observe:/private',
      'observe:/private/tmp',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `observe:${dispatchRoot}`,
      `observe:${plan.runtimePaths.codexHome}`,
      `observe:${plan.runtimePaths.fakeHome}`,
      `observe:${host.configPath()}`,
      `sha256:${host.configPath()}`,
      `observe:${host.configPath()}`,
      `observe:${dispatchRoot}`,
      'probe-effective',
      'spawn',
      'probe-runtime'
    ])
    expect(host.calls.filter((call) => call === 'spawn')).toEqual(['spawn'])
    expect(host.calls.indexOf('probe-effective')).toBeLessThan(host.calls.indexOf('spawn'))
    expect(host.calls.indexOf('spawn')).toBeLessThan(host.calls.indexOf('probe-runtime'))
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
    expect(host.calls).toEqual([
      'observe:/private',
      'observe:/private/tmp',
      'observe:/private',
      'observe:/private/tmp/orca-lab',
      'mkdir:/private/tmp/orca-lab:700',
      'observe:/private/tmp',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'mkdir:/private/tmp/orca-lab/runtime:700',
      'observe:/private/tmp/orca-lab',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      'mkdir:/private/tmp/orca-lab/runtime/dispatches:700',
      'observe:/private/tmp/orca-lab/runtime',
      'observe:/private/tmp/orca-lab/runtime/dispatches',
      `observe:${dirname(plan.runtimePaths.codexHome)}`
    ])
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
