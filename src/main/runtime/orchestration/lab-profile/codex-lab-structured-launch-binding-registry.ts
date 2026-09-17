import { createHash } from 'node:crypto'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import type { VerifiedLabWorktreeObservation } from './lab-worktree-observation'

export const CODEX_LAB_STRUCTURED_BINDING_REFUSAL_CODE =
  'ORCA_CODEX_LAB_STRUCTURED_BINDING_REFUSED' as const

export type CodexLabStructuredLaunchBinding = Readonly<{
  dispatchId: string
  plan: SealedCodexLabLaunchPlan
  worktree: VerifiedLabWorktreeObservation
}>

export class CodexLabStructuredBindingRefusal extends Error {
  readonly code = CODEX_LAB_STRUCTURED_BINDING_REFUSAL_CODE

  constructor(readonly reason: 'binding_invalid' | 'binding_conflict' | 'binding_missing') {
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
  assertBinding(candidate)
  const binding = Object.freeze({
    dispatchId: candidate.dispatchId,
    plan: candidate.plan,
    worktree: candidate.worktree
  })
  bindingsBySessionId.set(sessionId, binding)
  return binding
}

export function getCodexLabStructuredLaunchBinding(
  sessionId: string
): CodexLabStructuredLaunchBinding | undefined {
  return bindingsBySessionId.get(sessionId)
}

export function releaseCodexLabStructuredLaunchBinding(
  sessionId: string,
  dispatchId: string
): boolean {
  const binding = bindingsBySessionId.get(sessionId)
  if (!binding || binding.dispatchId !== dispatchId) {
    return false
  }
  return bindingsBySessionId.delete(sessionId)
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
