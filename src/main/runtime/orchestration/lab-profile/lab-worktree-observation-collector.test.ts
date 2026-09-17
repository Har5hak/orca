import { describe, expect, it, vi } from 'vitest'
import {
  LAB_DISPOSABLE_WORKTREE_ROOT,
  collectVerifiedLabWorktreeObservation,
  type LabWorktreeGitSnapshot,
  type LabWorktreeIdentityRecord,
  type LabWorktreeObservationCollectorDeps
} from './lab-worktree-observation-collector'
import { LAB_WORKTREE_OBSERVATION_REFUSAL_CODE } from './lab-worktree-observation'

const IDENTITY = 'wt2:local:disposable-instance'
const WORKTREE_PATH = `${LAB_DISPOSABLE_WORKTREE_ROOT}/disposable-worktree`
const COMMON_DIRECTORY = `${LAB_DISPOSABLE_WORKTREE_ROOT}/repository.git`
const LINKED_GIT_DIRECTORY = `${COMMON_DIRECTORY}/worktrees/disposable-worktree`
const HEAD_COMMIT = '1'.repeat(40)
const TREE_HASH = '2'.repeat(40)

const ADMISSION = Object.freeze({
  profile: 'lab-readonly-supervised-v1',
  adapter: 'codex-workspace-chatgpt-v1',
  agent: 'codex',
  maxConcurrency: 1,
  worktreeIdentity: IDENTITY,
  worktreeInstanceId: 'disposable-instance',
  expectedWorktreePath: WORKTREE_PATH
})

type FixtureOptions = Readonly<{
  candidates?: readonly LabWorktreeIdentityRecord[]
  realpaths?: Readonly<Record<string, string>>
  pathKinds?: Readonly<Record<string, 'directory' | 'missing' | 'other'>>
  snapshots?: readonly LabWorktreeGitSnapshot[]
}>

function identityRecord(path = WORKTREE_PATH): LabWorktreeIdentityRecord {
  return {
    identity: IDENTITY,
    executionHostId: 'local',
    kind: 'git-worktree',
    path
  }
}

function gitSnapshot(overrides: Partial<LabWorktreeGitSnapshot> = {}): LabWorktreeGitSnapshot {
  return {
    repositoryRoot: WORKTREE_PATH,
    commonDirectory: COMMON_DIRECTORY,
    gitDirectory: LINKED_GIT_DIRECTORY,
    headCommit: HEAD_COMMIT,
    treeHash: TREE_HASH,
    statusPorcelainV2: '',
    ...overrides
  }
}

function fixture(options: FixtureOptions = {}) {
  const candidates = options.candidates ?? [identityRecord()]
  const snapshots = options.snapshots ?? [gitSnapshot(), gitSnapshot()]
  let snapshotIndex = 0
  const resolveExactIdentity = vi.fn(async (_selector: string) => candidates)
  const realpathPath = vi.fn(async (path: string) => options.realpaths?.[path] ?? path)
  const statPath = vi.fn(
    async (path: string): Promise<'directory' | 'missing' | 'other'> =>
      options.pathKinds?.[path] ?? 'directory'
  )
  const takeGitSnapshot = vi.fn(async (_path: string): Promise<LabWorktreeGitSnapshot> => {
    const selected = snapshots.at(snapshotIndex)
    snapshotIndex += 1
    return selected ?? snapshots.at(-1) ?? gitSnapshot()
  })
  const deps: LabWorktreeObservationCollectorDeps = {
    resolveExactIdentity,
    realpathPath,
    statPath,
    takeGitSnapshot
  }
  return {
    deps,
    resolveExactIdentity,
    realpathPath,
    statPath,
    takeGitSnapshot
  }
}

async function collect(deps: LabWorktreeObservationCollectorDeps, admission = ADMISSION) {
  return collectVerifiedLabWorktreeObservation({ admission, deps })
}

function refusal(reason: string) {
  return expect.objectContaining({
    code: LAB_WORKTREE_OBSERVATION_REFUSAL_CODE,
    data: expect.objectContaining({ reason })
  })
}

describe('lab worktree observation collector', () => {
  it('resolves only the exact identity selector and verifies two stable host snapshots', async () => {
    const subject = fixture()

    const result = await collect(subject.deps)

    expect(subject.resolveExactIdentity).toHaveBeenCalledOnce()
    expect(subject.resolveExactIdentity).toHaveBeenCalledWith(`identity:${IDENTITY}`)
    expect(subject.realpathPath.mock.calls).toEqual([
      [LAB_DISPOSABLE_WORKTREE_ROOT],
      [WORKTREE_PATH]
    ])
    expect(subject.statPath.mock.calls).toEqual([[LAB_DISPOSABLE_WORKTREE_ROOT], [WORKTREE_PATH]])
    expect(subject.takeGitSnapshot.mock.calls).toEqual([[WORKTREE_PATH], [WORKTREE_PATH]])
    expect(result.observation).toMatchObject({
      selector: `identity:${IDENTITY}`,
      path: WORKTREE_PATH,
      disposable: true,
      clean: true,
      headCommit: HEAD_COMMIT,
      treeHash: TREE_HASH
    })
  })

  it('refuses a catalog occupant whose exact path differs from admission', async () => {
    const subject = fixture({
      candidates: [identityRecord(`${LAB_DISPOSABLE_WORKTREE_ROOT}/other-worktree`)]
    })

    await expect(collect(subject.deps)).rejects.toMatchObject(refusal('path_mismatch'))
    expect(subject.realpathPath).not.toHaveBeenCalled()
    expect(subject.takeGitSnapshot).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', []],
    ['ambiguous', [identityRecord(), identityRecord()]]
  ])('refuses an %s exact identity resolution', async (_label, candidates) => {
    const subject = fixture({ candidates })

    await expect(collect(subject.deps)).rejects.toMatchObject(
      refusal(candidates.length === 0 ? 'worktree_not_found' : 'worktree_ambiguous')
    )
    expect(subject.takeGitSnapshot).not.toHaveBeenCalled()
  })

  it('refuses a symlinked worktree path after independent realpath and stat checks', async () => {
    const subject = fixture({
      realpaths: {
        [WORKTREE_PATH]: `${LAB_DISPOSABLE_WORKTREE_ROOT}/real-worktree`
      }
    })

    await expect(collect(subject.deps)).rejects.toMatchObject(refusal('realpath_mismatch'))
    expect(subject.statPath).toHaveBeenCalledWith(WORKTREE_PATH)
    expect(subject.takeGitSnapshot).not.toHaveBeenCalled()
  })

  it('refuses when the fixed laboratory root itself resolves through a symlink', async () => {
    const subject = fixture({
      realpaths: {
        [LAB_DISPOSABLE_WORKTREE_ROOT]: '/private/tmp/redirected-lab-root'
      }
    })

    await expect(collect(subject.deps)).rejects.toMatchObject(refusal('worktree_not_disposable'))
    expect(subject.statPath).toHaveBeenCalledWith(LAB_DISPOSABLE_WORKTREE_ROOT)
    expect(subject.takeGitSnapshot).not.toHaveBeenCalled()
  })

  it('refuses a dirty worktree after taking both snapshots', async () => {
    const subject = fixture({
      snapshots: [
        gitSnapshot({ statusPorcelainV2: '1 .M N... 100644 file.txt\n' }),
        gitSnapshot({ statusPorcelainV2: '1 .M N... 100644 file.txt\n' })
      ]
    })

    await expect(collect(subject.deps)).rejects.toMatchObject(refusal('worktree_dirty'))
    expect(subject.takeGitSnapshot).toHaveBeenCalledTimes(2)
  })

  it('refuses Git state drift between the two snapshots', async () => {
    const subject = fixture({
      snapshots: [gitSnapshot(), gitSnapshot({ headCommit: '3'.repeat(40) })]
    })

    await expect(collect(subject.deps)).rejects.toMatchObject(refusal('git_head_mismatch'))
    expect(subject.takeGitSnapshot).toHaveBeenCalledTimes(2)
  })

  it('refuses a path outside the fixed laboratory root before host lookup', async () => {
    const subject = fixture({ candidates: [identityRecord('/private/tmp/outside-worktree')] })
    const admission = Object.freeze({
      ...ADMISSION,
      expectedWorktreePath: '/private/tmp/outside-worktree'
    })

    await expect(collect(subject.deps, admission)).rejects.toMatchObject(
      refusal('worktree_not_disposable')
    )
    expect(subject.resolveExactIdentity).not.toHaveBeenCalled()
    expect(subject.realpathPath).not.toHaveBeenCalled()
  })

  it('derives and refuses main-worktree status from Git directories, not a caller boolean', async () => {
    const subject = fixture({
      snapshots: [
        gitSnapshot({ gitDirectory: COMMON_DIRECTORY }),
        gitSnapshot({ gitDirectory: COMMON_DIRECTORY })
      ]
    })

    await expect(collect(subject.deps)).rejects.toMatchObject(refusal('worktree_not_disposable'))
  })
})
