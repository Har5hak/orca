import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../../../shared/child-process/run-process'
import type {
  CodexLabLiveConfinementHost,
  CodexLabTrustedFileObservation,
  PrepareVerifiedCodexLabLaunchInput
} from './codex-lab-command-confinement-live-contract'
import {
  isValidCodexLabHostReadinessReceipt,
  prepareVerifiedCodexLabLaunch
} from './codex-lab-command-confinement-live'
import {
  CODEX_LAB_LIVE_PROBE_EXECUTABLE,
  CODEX_LAB_LIVE_PROBE_SOURCE
} from './codex-lab-command-confinement-live-probe'
import {
  confinementControls,
  confinementInput,
  expectedConfinementProbeReport,
  preparedConfinementLayout,
  successfulProbeResult
} from './codex-lab-command-confinement.test-support'
import { sealedHostPlan } from './codex-lab-host-fake.test-support'

const RUN_NONCE = 'a'.repeat(32)
const DEVICE = '16777234'

function file(path: string, sha256: string, inode: string): CodexLabTrustedFileObservation {
  return Object.freeze({
    path,
    observedRealPath: path,
    kind: 'regular-file',
    executable: true,
    identity: Object.freeze({ device: DEVICE, inode }),
    sha256
  })
}

function harness(
  overrides: Readonly<{
    replaceProbeBeforeExecution?: boolean
    injectAuthJsonAfterProof?: boolean
  }> = {}
) {
  const plan = sealedHostPlan()
  const preparedLayout = preparedConfinementLayout(plan)
  const controls = confinementControls(plan, preparedLayout, RUN_NONCE, {
    worktreeReadTarget: join(plan.cwd, '.git'),
    outsideWriteRoot: realpathSync(userInfo().homedir)
  })
  const shell = file(CODEX_LAB_LIVE_PROBE_EXECUTABLE, 'b'.repeat(64), '701')
  const codex = file(plan.executable, plan.codexExecutableSha256, '702')
  let shellObservations = 0
  let layoutObservations = 0
  let spec: ProcessSpec | undefined
  const close = vi.fn(async () => undefined)
  const assertPostExecution = vi.fn()
  const openControlSession = vi.fn(async () => ({ controls, assertPostExecution, close }))
  const executeExact = vi.fn(async (candidate: ProcessSpec) => {
    spec = candidate
    const probe = {
      path: shell.path,
      argvPrefix: ['-c', CODEX_LAB_LIVE_PROBE_SOURCE, 'orca-codex-lab-confinement-probe'],
      observedRealPath: shell.observedRealPath,
      kind: 'regular-file' as const,
      executable: true as const,
      expectedSha256Candidate: shell.sha256,
      observedSha256: shell.sha256,
      device: shell.identity.device,
      inode: shell.identity.inode
    }
    const input = confinementInput({
      plan,
      preparedLayout,
      probeIdentityCandidate: probe,
      runNonce: RUN_NONCE,
      controls
    })
    return Object.freeze({
      process: successfulProbeResult(JSON.stringify(expectedConfinementProbeReport(input))),
      processTreeTermination: 'verified' as const
    })
  })
  const host: CodexLabLiveConfinementHost = Object.freeze({
    randomNonce: () => RUN_NONCE,
    observeExecutable: (path: string) => {
      if (path === CODEX_LAB_LIVE_PROBE_EXECUTABLE) {
        shellObservations += 1
        return overrides.replaceProbeBeforeExecution && shellObservations > 1
          ? file(path, 'c'.repeat(64), '703')
          : shell
      }
      if (path === plan.executable) {
        return codex
      }
      throw new Error(`unexpected executable observation: ${path}`)
    },
    observeLayout: () => {
      layoutObservations += 1
      if (overrides.injectAuthJsonAfterProof && layoutObservations > 1) {
        throw new Error('confinement auth.json must remain absent')
      }
      return {
        dispatchRootIdentity: preparedLayout.dispatchRootIdentity,
        codexHomeIdentity: preparedLayout.codexHomeIdentity,
        fakeHomeIdentity: preparedLayout.fakeHomeIdentity,
        configIdentity: preparedLayout.configIdentity,
        configSha256: preparedLayout.configSha256,
        authJson: 'absent' as const
      }
    },
    openControlSession,
    executeExact
  })
  const input: PrepareVerifiedCodexLabLaunchInput = Object.freeze({
    plan,
    preparedLayout
  })
  return {
    host,
    input,
    executeExact,
    openControlSession,
    close,
    assertPostExecution,
    readSpec: () => spec,
    readShellObservations: () => shellObservations,
    readLayoutObservations: () => layoutObservations
  }
}

describe('trusted live Codex laboratory command confinement', () => {
  it('executes the exact sandbox spec and mints readiness only after live proof', async () => {
    const world = harness()

    const verified = await prepareVerifiedCodexLabLaunch(world.input, world.host)

    const spec = world.readSpec()
    expect(spec).toBeDefined()
    expect(spec?.program).toBe(world.input.plan.executable)
    expect(spec?.args?.slice(0, 8)).toEqual([
      'sandbox',
      '--include-managed-config',
      '-P',
      'orca-lab-readonly-v1',
      '-C',
      world.input.plan.cwd,
      '--',
      CODEX_LAB_LIVE_PROBE_EXECUTABLE
    ])
    expect(spec?.args).toContain(CODEX_LAB_LIVE_PROBE_SOURCE)
    expect(spec?.terminationBarrier).toBe(true)
    expect(world.executeExact).toHaveBeenCalledOnce()
    expect(world.openControlSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeReadTarget: join(world.input.plan.cwd, '.git'),
        outsideWriteRoot: realpathSync(userInfo().homedir)
      })
    )
    expect(world.readShellObservations()).toBe(2)
    expect(world.readLayoutObservations()).toBe(2)
    expect(world.assertPostExecution).toHaveBeenCalledOnce()
    expect(world.close).toHaveBeenCalledOnce()
    expect(verified.receipt).toMatchObject({
      dispatchId: world.input.plan.dispatchId,
      controlTrust: 'trusted-local-host',
      probeIdentityTrust: 'host-re-attested',
      dispatchChannel: 'exact-unix-socket-permitted',
      arbitraryNetwork: 'denied',
      forbiddenWrites: 'denied',
      worktreeRead: 'verified',
      processTreeTermination: 'verified',
      appServerAttestation: 'required-at-opened-thread-gate'
    })
    expect(isValidCodexLabHostReadinessReceipt(verified.receipt)).toBe(true)
    expect(isValidCodexLabHostReadinessReceipt({ ...verified.receipt })).toBe(false)
  })

  it('ignores caller-injected proof paths and derives both trusted controls', async () => {
    const world = harness()
    const untrustedInput = {
      ...world.input,
      worktreeReadTarget: '/tmp/attacker-selected-read',
      outsideWriteRoot: '/tmp/attacker-selected-write-root'
    }

    await prepareVerifiedCodexLabLaunch(untrustedInput, world.host)

    expect(world.openControlSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeReadTarget: join(world.input.plan.cwd, '.git'),
        outsideWriteRoot: realpathSync(userInfo().homedir)
      })
    )
  })

  it('refuses a probe replacement before execution and still closes trusted controls', async () => {
    const world = harness({ replaceProbeBeforeExecution: true })

    await expect(prepareVerifiedCodexLabLaunch(world.input, world.host)).rejects.toMatchObject({
      reason: 'execution_failed'
    })

    expect(world.executeExact).not.toHaveBeenCalled()
    expect(world.assertPostExecution).not.toHaveBeenCalled()
    expect(world.close).toHaveBeenCalledOnce()
  })

  it('refuses auth.json injected after the immediate pre-execution layout attestation', async () => {
    const world = harness({ injectAuthJsonAfterProof: true })

    await expect(prepareVerifiedCodexLabLaunch(world.input, world.host)).rejects.toThrow(
      'confinement auth.json must remain absent'
    )

    expect(world.executeExact).toHaveBeenCalledOnce()
    expect(world.readLayoutObservations()).toBe(2)
    expect(world.close).toHaveBeenCalledOnce()
  })
})
