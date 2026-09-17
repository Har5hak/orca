import { dirname, join } from 'node:path'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  CODEX_LAB_ACTUAL_HOST_GAPS,
  buildExpectedCodexLabEffectivePolicy,
  buildExpectedCodexLabRuntimeObservations,
  digestCodexLabEvidence,
  type CodexLabEffectivePolicyObservation,
  type CodexLabHost,
  type CodexLabHostExecutionReason,
  type CodexLabHostExecutionResult,
  type CodexLabHostExecutionStage,
  type CodexLabRollbackEvidence,
  type CodexLabRuntimeObservations,
  type CodexLabSpawnRequest
} from './codex-lab-host-executor-contract'

export {
  CODEX_LAB_ACTUAL_HOST_GAPS,
  CODEX_LAB_EXPECTED_TOOL_INVENTORY,
  buildExpectedCodexLabEffectivePolicy,
  buildExpectedCodexLabRuntimeObservations
} from './codex-lab-host-executor-contract'
export type {
  CodexLabEffectivePolicyObservation,
  CodexLabHost,
  CodexLabHostExecutionResult,
  CodexLabRuntimeObservations,
  CodexLabSpawnRequest
} from './codex-lab-host-executor-contract'

class HostExecutionRefusal extends Error {
  constructor(readonly reason: CodexLabHostExecutionReason) {
    super(reason)
  }
}

function unverifiedRuntime(reason: string): CodexLabRuntimeObservations {
  return {
    filesystem: { state: 'unverified', reason },
    network: { state: 'unverified', reason },
    provider: { state: 'unverified', reason }
  }
}

function sameEvidence(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function assertSecureLayout(
  host: CodexLabHost,
  paths: Readonly<{
    dispatchRoot: string
    codexHome: string
    fakeHome: string
    configPath: string
  }>
): Promise<void> {
  const expected = [
    [paths.dispatchRoot, 'directory', 0o700],
    [paths.codexHome, 'directory', 0o700],
    [paths.fakeHome, 'directory', 0o700],
    [paths.configPath, 'file', 0o600]
  ] as const
  for (const [path, kind, mode] of expected) {
    const observed = await host.observePath(path)
    if (observed.kind !== kind || observed.mode !== mode) {
      throw new HostExecutionRefusal('layout_verification_failed')
    }
  }
}

async function rollbackHostExecution(args: {
  host: CodexLabHost
  dispatchRoot: string
  createdRoot: boolean
  processId?: string
}): Promise<readonly CodexLabRollbackEvidence[]> {
  const evidence: CodexLabRollbackEvidence[] = []
  let terminationConfirmed = true
  if (args.processId) {
    try {
      const terminated = await args.host.terminateProcess(args.processId)
      evidence.push({
        order: evidence.length + 1,
        action: 'terminate_process',
        status: 'succeeded',
        evidence: terminated.evidence
      })
    } catch (error) {
      terminationConfirmed = false
      evidence.push({
        order: evidence.length + 1,
        action: 'terminate_process',
        status: 'failed',
        evidence: errorMessage(error)
      })
    }
  }
  if (!args.createdRoot) {
    return evidence
  }
  if (!terminationConfirmed) {
    evidence.push({
      order: evidence.length + 1,
      action: 'remove_dispatch_root',
      status: 'skipped',
      evidence: 'process termination unconfirmed; root retained for containment evidence'
    })
    return evidence
  }
  try {
    const removed = await args.host.removeTree(args.dispatchRoot)
    evidence.push({
      order: evidence.length + 1,
      action: 'remove_dispatch_root',
      status: 'succeeded',
      evidence: removed.evidence
    })
  } catch (error) {
    evidence.push({
      order: evidence.length + 1,
      action: 'remove_dispatch_root',
      status: 'failed',
      evidence: errorMessage(error)
    })
  }
  return evidence
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown host failure'
}

function spawnRequest(plan: SealedCodexLabLaunchPlan): CodexLabSpawnRequest {
  return {
    executable: plan.executable,
    argv: plan.argv,
    cwd: plan.cwd,
    env: plan.environment.injected,
    shell: false
  }
}

export async function executeSealedCodexLabHostPlan(
  plan: SealedCodexLabLaunchPlan,
  host: CodexLabHost
): Promise<CodexLabHostExecutionResult> {
  let stage: CodexLabHostExecutionStage = 'validate_plan'
  let createdRoot = false
  let processId: string | undefined
  let effectivePolicy: CodexLabEffectivePolicyObservation = {
    state: 'unverified',
    reason: 'effective policy not observed'
  }
  let observations = unverifiedRuntime('runtime boundaries not observed')
  const dispatchRoot = dirname(plan.runtimePaths.codexHome)
  const configPath = join(plan.runtimePaths.codexHome, 'config.toml')
  try {
    assertSealedCodexLabLaunchPlan(plan)
    stage = 'freshness'
    if ((await host.observePath(dispatchRoot)).kind !== 'absent') {
      throw new HostExecutionRefusal('dispatch_root_not_fresh')
    }
    stage = 'create_layout'
    await host.makeDirectoryExclusive(dispatchRoot, 0o700)
    createdRoot = true
    await host.makeDirectoryExclusive(plan.runtimePaths.codexHome, 0o700)
    await host.makeDirectoryExclusive(plan.runtimePaths.fakeHome, 0o700)
    stage = 'write_config'
    await host.writeFileExclusive(configPath, plan.configToml, 0o600)
    stage = 'verify_layout'
    await assertSecureLayout(host, {
      dispatchRoot,
      codexHome: plan.runtimePaths.codexHome,
      fakeHome: plan.runtimePaths.fakeHome,
      configPath
    })
    stage = 'verify_config_digest'
    if ((await host.sha256File(configPath)) !== plan.receiptInputs.configSha256) {
      throw new HostExecutionRefusal('config_digest_mismatch')
    }
    stage = 'probe_effective_policy'
    effectivePolicy = await host.probeEffectivePolicy({
      executable: plan.executable,
      argv: plan.argv,
      cwd: plan.cwd,
      env: plan.environment.injected,
      configPath,
      shell: false,
      network: false,
      providerSession: false
    })
    if (effectivePolicy.state !== 'verified') {
      throw new HostExecutionRefusal('effective_policy_unverified')
    }
    if (!sameEvidence(effectivePolicy, buildExpectedCodexLabEffectivePolicy(plan))) {
      throw new HostExecutionRefusal('effective_policy_mismatch')
    }
    stage = 'spawn'
    const spawned = await host.spawnNoShell(spawnRequest(plan))
    if (!spawned.processId.trim()) {
      throw new Error('host returned an empty process identity')
    }
    processId = spawned.processId
    stage = 'probe_runtime_boundaries'
    observations = await host.probeRuntimeBoundaries({
      processId,
      dispatchRoot,
      configPath,
      worktreePath: plan.cwd
    })
    if (Object.values(observations).some((observation) => observation.state !== 'verified')) {
      throw new HostExecutionRefusal('runtime_observation_unverified')
    }
    const expectedObservations = buildExpectedCodexLabRuntimeObservations(
      plan,
      dispatchRoot,
      processId
    )
    if (!sameEvidence(observations, expectedObservations)) {
      throw new HostExecutionRefusal('runtime_observation_mismatch')
    }
    return {
      ok: true,
      receipt: {
        schemaVersion: 1,
        dispatchId: plan.dispatchId,
        processId,
        configPath,
        configSha256: plan.receiptInputs.configSha256,
        effectivePolicySha256: digestCodexLabEvidence(effectivePolicy),
        observations,
        actualHostGaps: CODEX_LAB_ACTUAL_HOST_GAPS
      },
      effectivePolicy,
      rollback: []
    }
  } catch (error) {
    const rollback = await rollbackHostExecution({
      host,
      dispatchRoot,
      createdRoot,
      ...(processId ? { processId } : {})
    })
    return {
      ok: false,
      stage,
      reason:
        error instanceof HostExecutionRefusal
          ? error.reason
          : stage === 'validate_plan'
            ? 'plan_invalid'
            : 'host_operation_failed',
      message: errorMessage(error),
      effectivePolicy,
      observations,
      rollback,
      actualHostGaps: CODEX_LAB_ACTUAL_HOST_GAPS
    }
  }
}
