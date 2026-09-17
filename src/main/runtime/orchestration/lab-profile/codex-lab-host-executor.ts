import { dirname, join } from 'node:path'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  prepareCodexLabRuntimeLayout,
  removeCodexLabRuntimeLayout,
  type CodexLabRuntimeLayoutRollback
} from './codex-lab-runtime-layout'
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

function layoutRollbackEvidence(
  rollback: readonly CodexLabRuntimeLayoutRollback[]
): readonly CodexLabRollbackEvidence[] {
  return rollback.map((step, index) => ({ ...step, order: index + 1 }))
}

async function removePreparedLayout(
  host: Pick<CodexLabPreparationHost, 'removeTree'>,
  prepared: PreparedCodexLabHostPlan
): Promise<readonly CodexLabRollbackEvidence[]> {
  return layoutRollbackEvidence(await removeCodexLabRuntimeLayout(prepared, host))
}

async function rollbackAcquiredProvider(args: {
  host: CodexLabProviderAttestationHost
  prepared: PreparedCodexLabHostPlan
  processId: string
}): Promise<readonly CodexLabRollbackEvidence[]> {
  try {
    const terminated = await args.host.terminateProcess(args.processId)
    const rootRollback = await removePreparedLayout(args.host, args.prepared)
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
    prepared.codexHome === plan.runtimePaths.codexHome &&
    prepared.fakeHome === plan.runtimePaths.fakeHome &&
    prepared.configPath === join(plan.runtimePaths.codexHome, 'config.toml') &&
    prepared.configSha256 === plan.receiptInputs.configSha256 &&
    prepared.dispatchRootIdentity.device.length > 0 &&
    prepared.dispatchRootIdentity.inode.length > 0 &&
    prepared.dispatchesRootIdentity.device.length > 0 &&
    prepared.dispatchesRootIdentity.inode.length > 0 &&
    sameEvidence(prepared.effectivePolicy, buildExpectedCodexLabEffectivePolicy(plan))
  )
}

export async function prepareSealedCodexLabHostPlan(
  plan: SealedCodexLabLaunchPlan,
  host: CodexLabPreparationHost
): Promise<CodexLabHostPreparationResult> {
  let stage: CodexLabHostExecutionStage = 'validate_plan'
  let effectivePolicy: CodexLabEffectivePolicyObservation = {
    state: 'unverified',
    reason: 'effective policy not observed'
  }
  const observations = unverifiedRuntime('runtime boundaries not observed')
  let preparedLayout: PreparedCodexLabHostPlan | undefined
  try {
    const layout = await prepareCodexLabRuntimeLayout(plan, host)
    if (!layout.ok) {
      return hostFailure({
        stage: layout.stage,
        reason: layout.reason,
        error: new Error(layout.message),
        effectivePolicy,
        observations,
        rollback: layoutRollbackEvidence(layout.rollback)
      })
    }
    preparedLayout = {
      ...layout.prepared,
      effectivePolicy: buildExpectedCodexLabEffectivePolicy(plan)
    }
    const configPath = layout.prepared.configPath
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
      prepared: { ...preparedLayout, effectivePolicy: verifiedPolicy },
      effectivePolicy: verifiedPolicy,
      rollback: []
    }
  } catch (error) {
    const rollback = preparedLayout ? await removePreparedLayout(host, preparedLayout) : []
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
      ? await rollbackAcquiredProvider({ host, prepared, processId })
      : preparationValidated
        ? await removePreparedLayout(host, prepared)
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
    const rollback = await removePreparedLayout(host, preparation.prepared)
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
