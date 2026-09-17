import { createHash } from 'node:crypto'
import { isAbsolute, normalize, parse, sep } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID
} from './codex-lab-launch-contract'
import {
  LabWorktreeObservationRefusal,
  type LabWorktreeAdmission,
  type LabWorktreeGitEvidence,
  type LabWorktreeHostEvidence,
  type LabWorktreeLookupEvidence,
  type LabWorktreeObservation,
  type LabWorktreeObservationDigests,
  type LabWorktreeObservationReceipt,
  type LabWorktreeObservationRefusalReason,
  type LabWorktreePinnedStringEvidence,
  type LabWorktreeRealpathEvidence,
  type VerifiedLabWorktreeObservation
} from './lab-worktree-observation-contract'

export {
  LAB_WORKTREE_OBSERVATION_REFUSAL_CODE,
  LabWorktreeObservationRefusal
} from './lab-worktree-observation-contract'
export type {
  LabWorktreeAdmission,
  LabWorktreeGitEvidence,
  LabWorktreeHostEvidence,
  LabWorktreeLookupEvidence,
  LabWorktreeObservation,
  LabWorktreeObservationDigests,
  LabWorktreeObservationReceipt,
  LabWorktreeObservationRefusalReason,
  LabWorktreePinnedStringEvidence,
  LabWorktreeRealpathEvidence,
  VerifiedLabWorktreeObservation
} from './lab-worktree-observation-contract'

export function verifyLabWorktreeObservation(input: {
  admission: LabWorktreeAdmission
  evidence: LabWorktreeHostEvidence
}): VerifiedLabWorktreeObservation {
  const { admission, evidence } = input
  validateAdmission(admission)
  validateLookup(admission, evidence.lookup)
  validateRealpath(admission, evidence.realpath)
  validateGit(admission, evidence.git)

  const observation: LabWorktreeObservation = Object.freeze({
    selector: evidence.lookup.selector,
    worktreeIdentity: admission.worktreeIdentity,
    worktreeInstanceId: admission.worktreeInstanceId,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    path: admission.expectedWorktreePath,
    realpath: evidence.realpath.canonicalPath,
    kind: 'git-worktree',
    preExisting: true,
    disposable: true,
    repositoryRoot: evidence.git.repositoryRoot.observed,
    commonDirectory: evidence.git.commonDirectory.observed,
    headCommit: evidence.git.headCommit.observed,
    treeHash: evidence.git.treeHash.observed,
    clean: true
  })
  const digests: LabWorktreeObservationDigests = Object.freeze({
    selectorSha256: sha256(observation.selector),
    worktreeIdentitySha256: sha256(observation.worktreeIdentity),
    worktreePathSha256: sha256(observation.path),
    repositoryRootSha256: sha256(observation.repositoryRoot),
    gitCommonDirectorySha256: sha256(observation.commonDirectory),
    gitHeadSha256: sha256(observation.headCommit),
    gitTreeSha256: sha256(observation.treeHash),
    observationSha256: sha256(`orca.lab-worktree-observation.v1\0${JSON.stringify(observation)}`)
  })
  const receipt: LabWorktreeObservationReceipt = Object.freeze({
    schema: 'orca.lab-worktree-observation.v1',
    profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
    adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    worktreeIdentity: observation.worktreeIdentity,
    worktreePath: observation.path,
    repositoryRoot: observation.repositoryRoot,
    headCommit: observation.headCommit,
    treeHash: observation.treeHash,
    clean: true,
    digests
  })
  return Object.freeze({ observation, receipt })
}

function validateAdmission(admission: LabWorktreeAdmission): void {
  if (!Object.isFrozen(admission)) {
    refuse('admission_not_frozen', 'admission')
  }
  const instanceId = parseCanonicalLocalIdentity(admission.worktreeIdentity)
  if (
    admission.profile !== LAB_READONLY_SUPERVISED_PROFILE_ID ||
    admission.adapter !== CODEX_WORKSPACE_CHATGPT_ADAPTER_ID ||
    admission.agent !== 'codex' ||
    admission.maxConcurrency !== 1 ||
    instanceId === null ||
    admission.worktreeInstanceId !== instanceId ||
    !isCanonicalAbsolutePath(admission.expectedWorktreePath)
  ) {
    refuse('admission_invalid', 'admission')
  }
}

function validateLookup(admission: LabWorktreeAdmission, lookup: LabWorktreeLookupEvidence): void {
  if (lookup.selector !== `identity:${admission.worktreeIdentity}`) {
    refuse('selector_invalid', 'lookup.selector')
  }
  if (lookup.state === 'missing') {
    refuse('worktree_not_found', 'lookup.state')
  }
  if (lookup.state === 'ambiguous') {
    refuse('worktree_ambiguous', 'lookup.state')
  }
  if (lookup.identity !== admission.worktreeIdentity) {
    refuse('identity_mismatch', 'lookup.identity')
  }
  if (lookup.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    refuse('execution_host_unsupported', 'lookup.executionHostId')
  }
  if (lookup.kind !== 'git-worktree') {
    refuse('worktree_kind_unsupported', 'lookup.kind')
  }
  if (!lookup.preExisting) {
    refuse('worktree_not_preexisting', 'lookup.preExisting')
  }
  if (!lookup.disposable) {
    refuse('worktree_not_disposable', 'lookup.disposable')
  }
  if (lookup.path !== admission.expectedWorktreePath || !isCanonicalAbsolutePath(lookup.path)) {
    refuse('path_mismatch', 'lookup.path')
  }
}

function validateRealpath(
  admission: LabWorktreeAdmission,
  realpath: LabWorktreeRealpathEvidence
): void {
  if (realpath.state !== 'directory') {
    refuse('path_unavailable', 'realpath.state')
  }
  if (
    realpath.requestedPath !== admission.expectedWorktreePath ||
    realpath.canonicalPath !== admission.expectedWorktreePath ||
    !isCanonicalAbsolutePath(realpath.canonicalPath)
  ) {
    refuse('realpath_mismatch', 'realpath.canonicalPath')
  }
}

function validateGit(admission: LabWorktreeAdmission, git: LabWorktreeGitEvidence): void {
  if (git.state !== 'observed') {
    refuse('git_evidence_unavailable', 'git.state')
  }
  if (
    !samePinnedCanonicalPath(git.repositoryRoot) ||
    git.repositoryRoot.observed !== admission.expectedWorktreePath
  ) {
    refuse('git_repository_mismatch', 'git.repositoryRoot')
  }
  if (!samePinnedCanonicalPath(git.commonDirectory)) {
    refuse('git_common_directory_mismatch', 'git.commonDirectory')
  }
  if (!validPinnedObjectId(git.headCommit)) {
    refuse(
      samePinnedValue(git.headCommit) ? 'git_evidence_invalid' : 'git_head_mismatch',
      'git.headCommit'
    )
  }
  if (!validPinnedObjectId(git.treeHash)) {
    refuse(
      samePinnedValue(git.treeHash) ? 'git_evidence_invalid' : 'git_tree_mismatch',
      'git.treeHash'
    )
  }
  if (git.statusPorcelainV2 !== '') {
    refuse('worktree_dirty', 'git.statusPorcelainV2')
  }
}

function parseCanonicalLocalIdentity(value: string): string | null {
  const parts = value.split(':')
  if (parts.length !== 3 || parts[0] !== 'wt2' || !parts[1] || !parts[2]) {
    return null
  }
  try {
    const executionHostId = decodeURIComponent(parts[1])
    const instanceId = decodeURIComponent(parts[2])
    if (
      executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      instanceId.length === 0 ||
      canonicalWorktreeIdentity({ worktreeId: '', executionHostId, instanceId }) !== value
    ) {
      return null
    }
    return instanceId
  } catch {
    return null
  }
}

function samePinnedCanonicalPath(evidence: LabWorktreePinnedStringEvidence): boolean {
  return (
    samePinnedValue(evidence) &&
    isCanonicalAbsolutePath(evidence.pinned) &&
    isCanonicalAbsolutePath(evidence.observed)
  )
}

function validPinnedObjectId(evidence: LabWorktreePinnedStringEvidence): boolean {
  return samePinnedValue(evidence) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.observed)
}

function samePinnedValue(evidence: LabWorktreePinnedStringEvidence): boolean {
  return evidence.pinned === evidence.observed
}

function isCanonicalAbsolutePath(value: string): boolean {
  const root = parse(value).root
  return (
    value.length > root.length &&
    value === value.trim() &&
    !value.includes('\u0000') &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !value.endsWith(sep)
  )
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function refuse(reason: LabWorktreeObservationRefusalReason, field: string): never {
  throw new LabWorktreeObservationRefusal({ reason, field })
}
