import { dirname, join } from 'node:path'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  CODEX_LAB_ACTUAL_HOST_GAPS,
  buildExpectedCodexLabEffectivePolicy,
  buildExpectedCodexLabRuntimeObservations,
  digestCodexLabEvidence,
  type AcquiredCodexLabProvider,
  type CodexLabEffectivePolicyObservation,
  type CodexLabHost,
  type CodexLabHostExecutionReason,
  type CodexLabHostExecutionFailure,
  type CodexLabHostExecutionResult,
  type CodexLabHostPreparationResult,
  type CodexLabHostExecutionStage,
  type CodexLabPreparationHost,
  type CodexLabProviderAttestationHost,
  type CodexLabRollbackEvidence,
  type CodexLabRuntimeObservations,
  type CodexLabSpawnRequest,
  type PreparedCodexLabHostPlan,
  type VerifiedCodexLabEffectivePolicyObservation
} from './codex-lab-host-executor-contract'

export {
  CODEX_LAB_ACTUAL_HOST_GAPS,
  CODEX_LAB_EXPECTED_TOOL_INVENTORY,
  buildExpectedCodexLabEffectivePolicy,
  buildExpectedCodexLabRuntimeObservations
} from './codex-lab-host-executor-contract'
export type {
  AcquiredCodexLabProvider,
  CodexLabEffectivePolicyObservation,
  CodexLabHost,
  CodexLabHostExecutionResult,
  CodexLabHostPreparationResult,
  CodexLabPreparationHost,
  CodexLabProviderAttestationHost,
  CodexLabRuntimeObservations,
  CodexLabSpawnRequest,
  PreparedCodexLabHostPlan
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
  host: CodexLabPreparationHost,
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

async function removeCreatedDispatchRoot(args: {
  host: Pick<CodexLabPreparationHost, 'removeTree'>
  dispatchRoot: string
  createdRoot: boolean
}): Promise<readonly CodexLabRollbackEvidence[]> {
  if (!args.createdRoot) {
    return []
  }
  try {
    const removed = await args.host.removeTree(args.dispatchRoot)
    return [
      {
        order: 1,
        action: 'remove_dispatch_root',
        status: 'succeeded',
        evidence: removed.evidence
      }
    ]
  } catch (error) {
    return [
      {
        order: 1,
        action: 'remove_dispatch_root',
        status: 'failed',
        evidence: errorMessage(error)
      }
    ]
  }
}

async function rollbackAcquiredProvider(args: {
  host: CodexLabProviderAttestationHost
  dispatchRoot: string
  processId: string
}): Promise<readonly CodexLabRollbackEvidence[]> {
  try {
    const terminated = await args.host.terminateProcess(args.processId)
    const rootRollback = await removeCreatedDispatchRoot({
      host: args.host,
      dispatchRoot: args.dispatchRoot,
      createdRoot: true
    })
    return [
      {
        order: 1,
        action: 'terminate_process',
        status: 'succeeded',
        evidence: terminated.evidence
      },
      ...rootRollback.map((step) => ({ ...step, order: step.order + 1 }))
    ]
  } catch (error) {
    return [
      {
        order: 1,
        action: 'terminate_process',
        status: 'failed',
        evidence: errorMessage(error)
      },
      {
        order: 2,
        action: 'remove_dispatch_root',
        status: 'skipped',
        evidence: 'process termination unconfirmed; root retained for containment evidence'
      }
    ]
  }
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

function hostFailure(args: {
  stage: CodexLabHostExecutionStage
  reason: CodexLabHostExecutionReason
  error: unknown
  effectivePolicy: CodexLabEffectivePolicyObservation
  observations: CodexLabRuntimeObservations
  rollback: readonly CodexLabRollbackEvidence[]
}): CodexLabHostExecutionFailure {
  return {
    ok: false,
    stage: args.stage,
    reason: args.reason,
    message: errorMessage(args.error),
    effectivePolicy: args.effectivePolicy,
    observations: args.observations,
    rollback: args.rollback,
    actualHostGaps: CODEX_LAB_ACTUAL_HOST_GAPS
  }
}

function preparationMatchesPlan(
  plan: SealedCodexLabLaunchPlan,
  prepared: PreparedCodexLabHostPlan
): boolean {
  const dispatchRoot = dirname(plan.runtimePaths.codexHome)
  return (
    prepared.schemaVersion === 1 &&
    prepared.dispatchId === plan.dispatchId &&
    prepared.dispatchRoot === dispatchRoot &&
    prepared.configPath === join(plan.runtimePaths.codexHome, 'config.toml') &&
    prepared.configSha256 === plan.receiptInputs.configSha256 &&
    sameEvidence(prepared.effectivePolicy, buildExpectedCodexLabEffectivePolicy(plan))
  )
}

export async function prepareSealedCodexLabHostPlan(
  plan: SealedCodexLabLaunchPlan,
  host: CodexLabPreparationHost
): Promise<CodexLabHostPreparationResult> {
  let stage: CodexLabHostExecutionStage = 'validate_plan'
  let createdRoot = false
  let effectivePolicy: CodexLabEffectivePolicyObservation = {
    state: 'unverified',
    reason: 'effective policy not observed'
  }
  const observations = unverifiedRuntime('runtime boundaries not observed')
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
    const verifiedPolicy: VerifiedCodexLabEffectivePolicyObservation = effectivePolicy
    return {
      ok: true,
      prepared: {
        schemaVersion: 1,
        dispatchId: plan.dispatchId,
        dispatchRoot,
        configPath,
        configSha256: plan.receiptInputs.configSha256,
        effectivePolicy: verifiedPolicy
      },
      effectivePolicy: verifiedPolicy,
      rollback: []
    }
  } catch (error) {
    const rollback = await removeCreatedDispatchRoot({ host, dispatchRoot, createdRoot })
    return hostFailure({
      stage,
      reason:
        error instanceof HostExecutionRefusal
          ? error.reason
          : stage === 'validate_plan'
            ? 'plan_invalid'
            : 'host_operation_failed',
      error,
      effectivePolicy,
      observations,
      rollback
    })
  }
}

export async function attestSealedCodexLabProviderAcquisition(
  plan: SealedCodexLabLaunchPlan,
  prepared: PreparedCodexLabHostPlan,
  acquired: AcquiredCodexLabProvider,
  host: CodexLabProviderAttestationHost
): Promise<CodexLabHostExecutionResult> {
  let stage: CodexLabHostExecutionStage = 'validate_plan'
  let observations = unverifiedRuntime('runtime boundaries not observed')
  const processId = acquired.processId
  let preparationValidated = false
  let providerIdentityValid = false
  try {
    assertSealedCodexLabLaunchPlan(plan)
    stage = 'validate_acquisition'
    if (!preparationMatchesPlan(plan, prepared)) {
      throw new HostExecutionRefusal('preparation_mismatch')
    }
    preparationValidated = true
    if (!processId.trim()) {
      throw new HostExecutionRefusal('provider_identity_invalid')
    }
    providerIdentityValid = true
    stage = 'probe_runtime_boundaries'
    observations = await host.probeRuntimeBoundaries({
      processId,
      dispatchRoot: prepared.dispatchRoot,
      configPath: prepared.configPath,
      worktreePath: plan.cwd
    })
    if (Object.values(observations).some((observation) => observation.state !== 'verified')) {
      throw new HostExecutionRefusal('runtime_observation_unverified')
    }
    const expectedObservations = buildExpectedCodexLabRuntimeObservations(
      plan,
      prepared.dispatchRoot,
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
        configPath: prepared.configPath,
        configSha256: prepared.configSha256,
        effectivePolicySha256: digestCodexLabEvidence(prepared.effectivePolicy),
        observations,
        actualHostGaps: CODEX_LAB_ACTUAL_HOST_GAPS
      },
      effectivePolicy: prepared.effectivePolicy,
      rollback: []
    }
  } catch (error) {
    const rollback = providerIdentityValid
      ? await rollbackAcquiredProvider({ host, dispatchRoot: prepared.dispatchRoot, processId })
      : preparationValidated
        ? await removeCreatedDispatchRoot({
            host,
            dispatchRoot: prepared.dispatchRoot,
            createdRoot: true
          })
        : []
    return hostFailure({
      stage,
      reason:
        error instanceof HostExecutionRefusal
          ? error.reason
          : stage === 'validate_plan'
            ? 'plan_invalid'
            : 'host_operation_failed',
      error,
      effectivePolicy: prepared.effectivePolicy,
      observations,
      rollback
    })
  }
}

export async function executeSealedCodexLabHostPlan(
  plan: SealedCodexLabLaunchPlan,
  host: CodexLabHost
): Promise<CodexLabHostExecutionResult> {
  const preparation = await prepareSealedCodexLabHostPlan(plan, host)
  if (!preparation.ok) {
    return preparation
  }
  const stage: CodexLabHostExecutionStage = 'spawn'
  try {
    const spawned = await host.spawnNoShell(spawnRequest(plan))
    if (!spawned.processId.trim()) {
      throw new Error('host returned an empty process identity')
    }
    return attestSealedCodexLabProviderAcquisition(
      plan,
      preparation.prepared,
      { processId: spawned.processId },
      host
    )
  } catch (error) {
    const rollback = await removeCreatedDispatchRoot({
      host,
      dispatchRoot: preparation.prepared.dispatchRoot,
      createdRoot: true
    })
    return hostFailure({
      stage,
      reason: 'host_operation_failed',
      error,
      effectivePolicy: preparation.effectivePolicy,
      observations: unverifiedRuntime('runtime boundaries not observed'),
      rollback
    })
  }
}
