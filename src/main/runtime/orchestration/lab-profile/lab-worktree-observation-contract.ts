import type { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID
} from './codex-lab-launch-contract'

export const LAB_WORKTREE_OBSERVATION_REFUSAL_CODE =
  'ORCA_LAB_WORKTREE_OBSERVATION_REFUSED' as const

export type LabWorktreeObservationRefusalReason =
  | 'admission_not_frozen'
  | 'admission_invalid'
  | 'selector_invalid'
  | 'worktree_not_found'
  | 'worktree_ambiguous'
  | 'identity_mismatch'
  | 'execution_host_unsupported'
  | 'worktree_kind_unsupported'
  | 'worktree_not_preexisting'
  | 'worktree_not_disposable'
  | 'path_mismatch'
  | 'path_unavailable'
  | 'realpath_mismatch'
  | 'git_evidence_unavailable'
  | 'git_evidence_invalid'
  | 'git_repository_mismatch'
  | 'git_common_directory_mismatch'
  | 'git_head_mismatch'
  | 'git_tree_mismatch'
  | 'worktree_dirty'

export class LabWorktreeObservationRefusal extends Error {
  readonly code = LAB_WORKTREE_OBSERVATION_REFUSAL_CODE

  constructor(
    readonly data: Readonly<{ reason: LabWorktreeObservationRefusalReason; field?: string }>
  ) {
    super(`Laboratory worktree observation refused: ${data.reason}`)
    this.name = 'LabWorktreeObservationRefusal'
  }
}

export type LabWorktreeAdmission = Readonly<{
  profile: string
  adapter: string
  agent: string
  maxConcurrency: number
  worktreeIdentity: string
  worktreeInstanceId: string
  expectedWorktreePath: string
}>

export type LabWorktreeLookupEvidence = Readonly<{
  state: 'found' | 'missing' | 'ambiguous'
  selector: string
  identity: string
  executionHostId: string
  kind: 'git-worktree' | 'folder-workspace' | 'other'
  path: string
  preExisting: boolean
  disposable: boolean
}>

export type LabWorktreeRealpathEvidence = Readonly<{
  state: 'directory' | 'missing' | 'other'
  requestedPath: string
  canonicalPath: string
}>

export type LabWorktreePinnedStringEvidence = Readonly<{
  pinned: string
  observed: string
}>

export type LabWorktreeGitEvidence = Readonly<{
  state: 'observed' | 'unavailable' | 'not-git'
  repositoryRoot: LabWorktreePinnedStringEvidence
  commonDirectory: LabWorktreePinnedStringEvidence
  headCommit: LabWorktreePinnedStringEvidence
  treeHash: LabWorktreePinnedStringEvidence
  statusPorcelainV2: string
}>

export type LabWorktreeHostEvidence = Readonly<{
  lookup: LabWorktreeLookupEvidence
  realpath: LabWorktreeRealpathEvidence
  git: LabWorktreeGitEvidence
}>

export type LabWorktreeObservation = Readonly<{
  selector: string
  worktreeIdentity: string
  worktreeInstanceId: string
  executionHostId: typeof LOCAL_EXECUTION_HOST_ID
  path: string
  realpath: string
  kind: 'git-worktree'
  preExisting: true
  disposable: true
  repositoryRoot: string
  commonDirectory: string
  headCommit: string
  treeHash: string
  clean: true
}>

export type LabWorktreeObservationDigests = Readonly<{
  selectorSha256: string
  worktreeIdentitySha256: string
  worktreePathSha256: string
  repositoryRootSha256: string
  gitCommonDirectorySha256: string
  gitHeadSha256: string
  gitTreeSha256: string
  observationSha256: string
}>

export type LabWorktreeObservationReceipt = Readonly<{
  schema: 'orca.lab-worktree-observation.v1'
  profile: typeof LAB_READONLY_SUPERVISED_PROFILE_ID
  adapter: typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
  worktreeIdentity: string
  worktreePath: string
  repositoryRoot: string
  headCommit: string
  treeHash: string
  clean: true
  digests: LabWorktreeObservationDigests
}>

export type VerifiedLabWorktreeObservation = Readonly<{
  observation: LabWorktreeObservation
  receipt: LabWorktreeObservationReceipt
}>
