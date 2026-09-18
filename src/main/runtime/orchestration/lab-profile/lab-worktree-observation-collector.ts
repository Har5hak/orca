import { isAbsolute, normalize, relative, sep } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { canonicalWorktreeIdentity } from '../../../../shared/worktree/identity'
import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
} from './codex-lab-launch-contract'
import {
  LabWorktreeObservationRefusal,
  type LabWorktreeAdmission,
  type LabWorktreeObservationRefusalReason,
  type VerifiedLabWorktreeObservation,
  verifyLabWorktreeObservation
} from './lab-worktree-observation'

export const LAB_DISPOSABLE_WORKTREE_ROOT = '/private/tmp/orca-lab' as const

export type LabWorktreeIdentityRecord = Readonly<{
  identity: string
  executionHostId: string
  kind: 'git-worktree' | 'folder-workspace' | 'other'
  path: string
}>

export type LabWorktreeGitSnapshot = Readonly<{
  repositoryRoot: string
  commonDirectory: string
  gitDirectory: string
  headCommit: string
  treeHash: string
  statusPorcelainV2: string
}>

export type LabWorktreeObservationCollectorDeps = Readonly<{
  resolveExactIdentity: (selector: string) => Promise<readonly LabWorktreeIdentityRecord[]>
  realpathPath: (path: string) => Promise<string>
  statPath: (path: string) => Promise<'directory' | 'missing' | 'other'>
  takeGitSnapshot: (path: string) => Promise<LabWorktreeGitSnapshot>
}>

export async function collectVerifiedLabWorktreeObservation(input: {
  admission: LabWorktreeAdmission
  deps: LabWorktreeObservationCollectorDeps
}): Promise<VerifiedLabWorktreeObservation> {
  const { admission, deps } = input
  validateAdmissionBeforeHostReads(admission)

  const selector = `identity:${admission.worktreeIdentity}`
  const candidates = await resolveIdentityCandidates(deps, selector)
  const worktree = requireExactIdentityCandidate(admission, candidates)

  const allowedRoot = await observeDirectory(deps, LAB_DISPOSABLE_WORKTREE_ROOT)
  if (allowedRoot.kind !== 'directory' || allowedRoot.realpath !== LAB_DISPOSABLE_WORKTREE_ROOT) {
    refuse('worktree_not_disposable', 'allowedLabRoot')
  }

  const observedPath = await observeDirectory(deps, worktree.path)
  if (observedPath.kind !== 'directory') {
    refuse('path_unavailable', 'realpath.state')
  }
  if (observedPath.realpath !== admission.expectedWorktreePath) {
    refuse('realpath_mismatch', 'realpath.canonicalPath')
  }
  if (!isStrictlyInside(allowedRoot.realpath, observedPath.realpath)) {
    refuse('worktree_not_disposable', 'lookup.disposable')
  }

  const [pinnedGit, observedGit] = await takeTwoGitSnapshots(deps, observedPath.realpath)
  validateGitDirectoryEvidence(pinnedGit, observedGit)
  if (pinnedGit.statusPorcelainV2 !== '' || observedGit.statusPorcelainV2 !== '') {
    refuse('worktree_dirty', 'git.statusPorcelainV2')
  }

  return verifyLabWorktreeObservation({
    admission,
    evidence: {
      lookup: {
        state: 'found',
        selector,
        identity: worktree.identity,
        executionHostId: worktree.executionHostId,
        kind: worktree.kind,
        path: worktree.path,
        preExisting: true,
        disposable: true
      },
      realpath: {
        state: 'directory',
        requestedPath: worktree.path,
        canonicalPath: observedPath.realpath
      },
      git: {
        state: 'observed',
        repositoryRoot: {
          pinned: pinnedGit.repositoryRoot,
          observed: observedGit.repositoryRoot
        },
        commonDirectory: {
          pinned: pinnedGit.commonDirectory,
          observed: observedGit.commonDirectory
        },
        headCommit: { pinned: pinnedGit.headCommit, observed: observedGit.headCommit },
        treeHash: { pinned: pinnedGit.treeHash, observed: observedGit.treeHash },
        statusPorcelainV2: observedGit.statusPorcelainV2
      }
    }
  })
}

async function resolveIdentityCandidates(
  deps: LabWorktreeObservationCollectorDeps,
  selector: string
): Promise<readonly LabWorktreeIdentityRecord[]> {
  try {
    return await deps.resolveExactIdentity(selector)
  } catch {
    refuse('worktree_not_found', 'lookup.state')
  }
}

function requireExactIdentityCandidate(
  admission: LabWorktreeAdmission,
  candidates: readonly LabWorktreeIdentityRecord[]
): LabWorktreeIdentityRecord {
  if (candidates.length === 0) {
    refuse('worktree_not_found', 'lookup.state')
  }
  if (candidates.length !== 1) {
    refuse('worktree_ambiguous', 'lookup.state')
  }
  const candidate = candidates[0]
  if (candidate.identity !== admission.worktreeIdentity) {
    refuse('identity_mismatch', 'lookup.identity')
  }
  if (candidate.executionHostId !== LOCAL_EXECUTION_HOST_ID) {
    refuse('execution_host_unsupported', 'lookup.executionHostId')
  }
  if (candidate.kind !== 'git-worktree') {
    refuse('worktree_kind_unsupported', 'lookup.kind')
  }
  if (candidate.path !== admission.expectedWorktreePath) {
    refuse('path_mismatch', 'lookup.path')
  }
  return candidate
}

async function observeDirectory(
  deps: LabWorktreeObservationCollectorDeps,
  path: string
): Promise<Readonly<{ realpath: string; kind: 'directory' | 'missing' | 'other' }>> {
  let observedRealpath: string
  try {
    observedRealpath = await deps.realpathPath(path)
  } catch {
    observedRealpath = ''
  }
  let kind: 'directory' | 'missing' | 'other'
  try {
    kind = await deps.statPath(path)
  } catch {
    kind = 'missing'
  }
  return Object.freeze({ realpath: observedRealpath, kind })
}

async function takeTwoGitSnapshots(
  deps: LabWorktreeObservationCollectorDeps,
  path: string
): Promise<readonly [LabWorktreeGitSnapshot, LabWorktreeGitSnapshot]> {
  try {
    const pinned = await deps.takeGitSnapshot(path)
    const observed = await deps.takeGitSnapshot(path)
    return [pinned, observed]
  } catch {
    refuse('git_evidence_unavailable', 'git.state')
  }
}

function validateGitDirectoryEvidence(
  pinned: LabWorktreeGitSnapshot,
  observed: LabWorktreeGitSnapshot
): void {
  if (
    !isCanonicalAbsolutePath(pinned.gitDirectory) ||
    !isCanonicalAbsolutePath(observed.gitDirectory)
  ) {
    refuse('git_evidence_invalid', 'git.gitDirectory')
  }
  if (pinned.gitDirectory !== observed.gitDirectory) {
    refuse('git_evidence_invalid', 'git.gitDirectory')
  }
  if (
    pinned.gitDirectory === pinned.commonDirectory ||
    observed.gitDirectory === observed.commonDirectory
  ) {
    refuse('worktree_not_disposable', 'git.gitDirectory')
  }
}

function validateAdmissionBeforeHostReads(admission: LabWorktreeAdmission): void {
  if (!Object.isFrozen(admission)) {
    refuse('admission_not_frozen', 'admission')
  }
  const expectedIdentity = canonicalWorktreeIdentity({
    worktreeId: '',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    instanceId: admission.worktreeInstanceId
  })
  if (
    admission.profile !== LAB_READONLY_SUPERVISED_PROFILE_ID ||
    admission.adapter !== CODEX_WORKSPACE_CHATGPT_ADAPTER_ID ||
    admission.agent !== 'codex' ||
    admission.maxConcurrency !== LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY ||
    admission.worktreeInstanceId.length === 0 ||
    admission.worktreeIdentity !== expectedIdentity ||
    !isCanonicalAbsolutePath(admission.expectedWorktreePath)
  ) {
    refuse('admission_invalid', 'admission')
  }
  if (!isStrictlyInside(LAB_DISPOSABLE_WORKTREE_ROOT, admission.expectedWorktreePath)) {
    refuse('worktree_not_disposable', 'admission.expectedWorktreePath')
  }
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  )
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 1 &&
    value === value.trim() &&
    !value.includes('\u0000') &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !value.endsWith(sep)
  )
}

function refuse(reason: LabWorktreeObservationRefusalReason, field: string): never {
  throw new LabWorktreeObservationRefusal({ reason, field })
}
