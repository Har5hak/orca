import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeCodexLabHost, sealedHostPlan } from './codex-lab-host-fake.test-support'
import {
  CodexLabRuntimeCleanupIncomplete,
  prepareCodexLabRuntimeLayout,
  removeCodexLabRuntimeLayout,
  type CodexLabPathObservation,
  type CodexLabRuntimeLayoutHost
} from './codex-lab-runtime-layout'

function layoutHost(
  host: FakeCodexLabHost,
  observePath: (path: string) => Promise<CodexLabPathObservation> = (path) => host.observePath(path)
): CodexLabRuntimeLayoutHost {
  return {
    observePath,
    makeDirectoryExclusive: (path, mode, parent) => host.makeDirectoryExclusive(path, mode, parent),
    writeFileExclusive: (path, contents, mode, parent) =>
      host.writeFileExclusive(path, contents, mode, parent),
    sha256File: (path, identity) => host.sha256File(path, identity),
    removeTree: (path, rootIdentity, parentIdentity) =>
      host.removeTree(path, rootIdentity, parentIdentity)
  }
}

describe('Codex laboratory runtime layout core', () => {
  it('materializes and verifies only layout evidence without policy probes or provider spawn', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)

    const result = await prepareCodexLabRuntimeLayout(plan, layoutHost(host))

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.message)
    }
    expect(result.prepared).toMatchObject({
      dispatchId: plan.dispatchId,
      dispatchRoot: dirname(plan.runtimePaths.codexHome),
      codexHome: plan.runtimePaths.codexHome,
      fakeHome: plan.runtimePaths.fakeHome,
      configPath: host.configPath(),
      configSha256: plan.receiptInputs.configSha256,
      dispatchRootIdentity: { device: 'fake-device' },
      dispatchesRootIdentity: { device: 'fake-device' }
    })
    expect(host.effectiveProbeRequests).toEqual([])
    expect(host.spawnRequests).toEqual([])
    expect(host.runtimeProbeRequests).toEqual([])
  })

  it('rejects a relocated home before any host filesystem access', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const relocated = {
      ...plan,
      runtimePaths: {
        ...plan.runtimePaths,
        codexHome: '/private/tmp/not-the-orca-lab/codex-home'
      }
    }

    const result = await prepareCodexLabRuntimeLayout(relocated, layoutHost(host))

    expect(result).toMatchObject({
      ok: false,
      stage: 'validate_plan',
      reason: 'layout_path_invalid',
      rollback: []
    })
    expect(host.calls).toEqual([])
  })

  it('refuses an insecure pre-existing owned parent without touching a Dispatch root', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const privateTmp = await host.observePath('/private/tmp')
    if (privateTmp.kind === 'absent') {
      throw new Error('fake /private/tmp must exist')
    }
    await host.makeDirectoryExclusive('/private/tmp/orca-lab', 0o700, privateTmp.identity)
    host.pathModes.set('/private/tmp/orca-lab', 0o755)
    host.calls.length = 0

    const result = await prepareCodexLabRuntimeLayout(plan, layoutHost(host))

    expect(result).toMatchObject({
      ok: false,
      stage: 'prepare_parents',
      reason: 'layout_verification_failed',
      rollback: []
    })
    expect(host.pathKinds.has(dirname(plan.runtimePaths.codexHome))).toBe(false)
  })

  it('removes its captured root when config readback does not match the sealed digest', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    host.configDigestOverride = 'b'.repeat(64)

    const result = await prepareCodexLabRuntimeLayout(plan, layoutHost(host))

    expect(result).toMatchObject({
      ok: false,
      stage: 'verify_config_digest',
      reason: 'config_digest_mismatch',
      rollback: [{ action: 'remove_dispatch_root', status: 'succeeded' }]
    })
    expect(host.pathKinds.has(dirname(plan.runtimePaths.codexHome))).toBe(false)
  })

  it('keeps rollback failed and categorical when native cleanup leaves a quarantine residual', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const prepared = await prepareCodexLabRuntimeLayout(plan, layoutHost(host))
    if (!prepared.ok) {
      throw new Error(prepared.message)
    }
    const quarantinePath = `${prepared.prepared.dispatchRoot}.cleanup-test`

    const rollback = await removeCodexLabRuntimeLayout(prepared.prepared, {
      removeTree: async () => {
        throw new CodexLabRuntimeCleanupIncomplete(quarantinePath)
      }
    })

    expect(rollback).toEqual([
      {
        action: 'remove_dispatch_root',
        status: 'failed',
        reason: 'cleanup_incomplete',
        evidence: expect.stringContaining(quarantinePath)
      }
    ])
  })

  it('retains a replacement root instead of deleting through a stale identity', async () => {
    const plan = sealedHostPlan()
    const host = new FakeCodexLabHost(plan)
    const dispatchRoot = dirname(plan.runtimePaths.codexHome)
    let replaced = false
    const observePath = async (path: string): Promise<CodexLabPathObservation> => {
      const observed = await host.observePath(path)
      if (!replaced && path === dispatchRoot && observed.kind === 'directory') {
        replaced = true
        host.pathIdentities.set(path, { device: 'fake-device', inode: 'replacement' })
        return host.observePath(path)
      }
      return observed
    }

    const result = await prepareCodexLabRuntimeLayout(plan, layoutHost(host, observePath))

    expect(result).toMatchObject({
      ok: false,
      stage: 'verify_layout',
      reason: 'layout_verification_failed',
      rollback: [{ action: 'remove_dispatch_root', status: 'failed' }]
    })
    expect(host.pathKinds.get(dispatchRoot)).toBe('directory')
    expect(host.pathIdentities.get(dispatchRoot)).toEqual({
      device: 'fake-device',
      inode: 'replacement'
    })
  })
})
