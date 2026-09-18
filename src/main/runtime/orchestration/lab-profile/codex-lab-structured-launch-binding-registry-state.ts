import { createHash } from 'node:crypto'
import {
  claimCodexLabDynamicToolHostFactory,
  isCodexLabDynamicToolHostFactoryBoundTo,
  revokeCodexLabDynamicToolHostFactory,
  type CodexLabDynamicToolHostFactory
} from '../../../codex/codex-lab-dynamic-tool-host'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import type { VerifiedLabWorktreeObservation } from './lab-worktree-observation'

export const CODEX_LAB_STRUCTURED_BINDING_REFUSAL_CODE =
  'ORCA_CODEX_LAB_STRUCTURED_BINDING_REFUSED' as const

export type CodexLabStructuredLaunchBinding = Readonly<{
  dispatchId: string
  plan: SealedCodexLabLaunchPlan
  worktree: VerifiedLabWorktreeObservation
  /** Ephemeral host authority. This registry is in-memory only; never persist this factory. */
  labDynamicToolHostFactory: CodexLabDynamicToolHostFactory
}>

export type CodexLabStructuredLaunchBindingMetadata = Readonly<
  Pick<CodexLabStructuredLaunchBinding, 'dispatchId' | 'plan' | 'worktree'>
>

export class CodexLabStructuredBindingRefusal extends Error {
  readonly code = CODEX_LAB_STRUCTURED_BINDING_REFUSAL_CODE

  constructor(
    readonly reason:
      | 'binding_invalid'
      | 'binding_conflict'
      | 'binding_missing'
      | 'agent_mode_mismatch'
  ) {
    super(`Codex laboratory structured launch binding refused: ${reason}`)
    this.name = 'CodexLabStructuredBindingRefusal'
  }
}

const bindingsBySessionId = new Map<string, CodexLabStructuredLaunchBinding>()

export function registerCodexLabStructuredLaunchBinding(
  sessionId: string,
  candidate: CodexLabStructuredLaunchBinding
): CodexLabStructuredLaunchBinding {
  if (!sessionId.trim() || bindingsBySessionId.has(sessionId)) {
    throw new CodexLabStructuredBindingRefusal('binding_conflict')
  }
  const binding = Object.freeze({
    dispatchId: candidate.dispatchId,
    plan: candidate.plan,
    worktree: candidate.worktree,
    labDynamicToolHostFactory: candidate.labDynamicToolHostFactory
  })
  assertBinding(binding)
  if (!claimCodexLabDynamicToolHostFactory(binding.labDynamicToolHostFactory)) {
    throw new CodexLabStructuredBindingRefusal('binding_conflict')
  }
  bindingsBySessionId.set(sessionId, binding)
  return binding
}

export function getCodexLabStructuredLaunchBindingAuthority(
  sessionId: string
): CodexLabStructuredLaunchBinding | undefined {
  return bindingsBySessionId.get(sessionId)
}

export function getCodexLabStructuredLaunchBindingMetadata(
  sessionId: string
): CodexLabStructuredLaunchBindingMetadata | undefined {
  const binding = bindingsBySessionId.get(sessionId)
  return binding
    ? Object.freeze({
        dispatchId: binding.dispatchId,
        plan: binding.plan,
        worktree: binding.worktree
      })
    : undefined
}

export function releaseCodexLabStructuredLaunchBinding(
  sessionId: string,
  dispatchId: string
): boolean {
  const binding = bindingsBySessionId.get(sessionId)
  if (!binding || binding.dispatchId !== dispatchId) {
    return false
  }
  if (!bindingsBySessionId.delete(sessionId)) {
    return false
  }
  revokeCodexLabDynamicToolHostFactory(binding.labDynamicToolHostFactory)
  return true
}

function assertBinding(binding: CodexLabStructuredLaunchBinding): void {
  try {
    assertSealedCodexLabLaunchPlan(binding.plan)
  } catch {
    throw new CodexLabStructuredBindingRefusal('binding_invalid')
  }
  const { observation, receipt } = binding.worktree
  if (
    !Object.isFrozen(binding.plan) ||
    !Object.isFrozen(binding.worktree) ||
    !Object.isFrozen(observation) ||
    !Object.isFrozen(receipt) ||
    !Object.isFrozen(receipt.digests) ||
    binding.dispatchId !== binding.plan.dispatchId ||
    binding.plan.worktreeIdentity !== observation.worktreeIdentity ||
    binding.plan.cwd !== observation.path ||
    observation.realpath !== observation.path ||
    observation.executionHostId !== 'local' ||
    observation.kind !== 'git-worktree' ||
    !observation.preExisting ||
    !observation.disposable ||
    !observation.clean ||
    receipt.profile !== binding.plan.profile ||
    receipt.adapter !== binding.plan.adapter ||
    receipt.worktreeIdentity !== observation.worktreeIdentity ||
    receipt.worktreePath !== observation.path ||
    receipt.repositoryRoot !== observation.repositoryRoot ||
    receipt.headCommit !== observation.headCommit ||
    receipt.treeHash !== observation.treeHash ||
    !isCodexLabDynamicToolHostFactoryBoundTo(binding.labDynamicToolHostFactory, {
      dispatchId: binding.dispatchId,
      endpointSha256: binding.plan.receiptInputs.gatewaySocketPathSha256,
      gatewayAccessSha256: binding.plan.gatewayAccessSha256
    }) ||
    !receipt.clean ||
    !digestsMatch(binding.worktree)
  ) {
    throw new CodexLabStructuredBindingRefusal('binding_invalid')
  }
}

function digestsMatch(worktree: VerifiedLabWorktreeObservation): boolean {
  const { observation, receipt } = worktree
  return (
    receipt.digests.selectorSha256 === sha256(observation.selector) &&
    receipt.digests.worktreeIdentitySha256 === sha256(observation.worktreeIdentity) &&
    receipt.digests.worktreePathSha256 === sha256(observation.path) &&
    receipt.digests.repositoryRootSha256 === sha256(observation.repositoryRoot) &&
    receipt.digests.gitCommonDirectorySha256 === sha256(observation.commonDirectory) &&
    receipt.digests.gitHeadSha256 === sha256(observation.headCommit) &&
    receipt.digests.gitTreeSha256 === sha256(observation.treeHash) &&
    receipt.digests.observationSha256 ===
      sha256(`orca.lab-worktree-observation.v1\0${JSON.stringify(observation)}`)
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
