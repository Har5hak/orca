import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  LAB_WORKTREE_OBSERVATION_REFUSAL_CODE,
  type LabWorktreeHostEvidence,
  verifyLabWorktreeObservation
} from './lab-worktree-observation'

const IDENTITY = 'wt2:local:disposable-instance'
const WORKTREE_PATH = '/private/tmp/orca-lab/disposable-worktree'
const COMMON_DIRECTORY = '/private/tmp/orca-lab/repository.git'
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

type LookupFixture = {
  state: 'found' | 'missing' | 'ambiguous'
  selector: string
  identity: string
  executionHostId: string
  kind: 'git-worktree' | 'folder-workspace' | 'other'
  path: string
  preExisting: boolean
  disposable: boolean
}

type RealpathFixture = {
  state: 'directory' | 'missing' | 'other'
  requestedPath: string
  canonicalPath: string
}

type PinnedStringFixture = { pinned: string; observed: string }
type GitFixture = {
  state: 'observed' | 'unavailable' | 'not-git'
  repositoryRoot: PinnedStringFixture
  commonDirectory: PinnedStringFixture
  headCommit: PinnedStringFixture
  treeHash: PinnedStringFixture
  statusPorcelainV2: string
}

function evidence(overrides?: {
  lookup?: Partial<LookupFixture>
  realpath?: Partial<RealpathFixture>
  git?: Partial<GitFixture>
}): LabWorktreeHostEvidence {
  return {
    lookup: {
      state: 'found',
      selector: `identity:${IDENTITY}`,
      identity: IDENTITY,
      executionHostId: 'local',
      kind: 'git-worktree',
      path: WORKTREE_PATH,
      preExisting: true,
      disposable: true,
      ...overrides?.lookup
    },
    realpath: {
      state: 'directory',
      requestedPath: WORKTREE_PATH,
      canonicalPath: WORKTREE_PATH,
      ...overrides?.realpath
    },
    git: {
      state: 'observed',
      repositoryRoot: { pinned: WORKTREE_PATH, observed: WORKTREE_PATH },
      commonDirectory: { pinned: COMMON_DIRECTORY, observed: COMMON_DIRECTORY },
      headCommit: { pinned: HEAD_COMMIT, observed: HEAD_COMMIT },
      treeHash: { pinned: TREE_HASH, observed: TREE_HASH },
      statusPorcelainV2: '',
      ...overrides?.git
    }
  }
}

function verify(overrides?: Parameters<typeof evidence>[0]) {
  return verifyLabWorktreeObservation({ admission: ADMISSION, evidence: evidence(overrides) })
}

describe('lab worktree host observation', () => {
  it('returns a deeply frozen, digest-bound, secret-free observation and receipt', () => {
    const result = verify()

    expect(result.observation).toEqual({
      selector: `identity:${IDENTITY}`,
      worktreeIdentity: IDENTITY,
      worktreeInstanceId: 'disposable-instance',
      executionHostId: 'local',
      path: WORKTREE_PATH,
      realpath: WORKTREE_PATH,
      kind: 'git-worktree',
      preExisting: true,
      disposable: true,
      repositoryRoot: WORKTREE_PATH,
      commonDirectory: COMMON_DIRECTORY,
      headCommit: HEAD_COMMIT,
      treeHash: TREE_HASH,
      clean: true
    })
    expect(result.receipt).toMatchObject({
      schema: 'orca.lab-worktree-observation.v1',
      profile: 'lab-readonly-supervised-v1',
      adapter: 'codex-workspace-chatgpt-v1',
      worktreeIdentity: IDENTITY,
      worktreePath: WORKTREE_PATH,
      repositoryRoot: WORKTREE_PATH,
      headCommit: HEAD_COMMIT,
      treeHash: TREE_HASH,
      clean: true,
      digests: {
        gitCommonDirectorySha256: sha256(COMMON_DIRECTORY),
        gitHeadSha256: sha256(HEAD_COMMIT),
        gitTreeSha256: sha256(TREE_HASH)
      }
    })
    expect(result.receipt.digests.observationSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.observation)).toBe(true)
    expect(Object.isFrozen(result.receipt)).toBe(true)
    expect(Object.isFrozen(result.receipt.digests)).toBe(true)
  })

  it('allowlists receipt fields so unexpected secrets neither leak nor affect the digest', () => {
    const clean = verify()
    const pollutedEvidence = {
      ...evidence(),
      apiToken: 'sk-forbidden',
      git: { ...evidence().git, credential: 'secret-forbidden' }
    }
    const polluted = verifyLabWorktreeObservation({
      admission: ADMISSION,
      evidence: pollutedEvidence
    })

    expect(polluted).toEqual(clean)
    expect(JSON.stringify(polluted)).not.toMatch(/sk-forbidden|secret-forbidden/)
  })

  it.each([
    {
      label: 'current selector',
      reason: 'selector_invalid',
      overrides: { lookup: { selector: 'current' } }
    },
    {
      label: 'path selector',
      reason: 'selector_invalid',
      overrides: { lookup: { selector: `path:${WORKTREE_PATH}` } }
    },
    {
      label: 'missing lookup',
      reason: 'worktree_not_found',
      overrides: { lookup: { state: 'missing' as const } }
    },
    {
      label: 'ambiguous lookup',
      reason: 'worktree_ambiguous',
      overrides: { lookup: { state: 'ambiguous' as const } }
    },
    {
      label: 'different occupant',
      reason: 'identity_mismatch',
      overrides: { lookup: { identity: 'wt2:local:other-instance' } }
    },
    {
      label: 'remote host',
      reason: 'execution_host_unsupported',
      overrides: { lookup: { executionHostId: 'ssh:builder' } }
    },
    {
      label: 'folder workspace',
      reason: 'worktree_kind_unsupported',
      overrides: { lookup: { kind: 'folder-workspace' as const } }
    },
    {
      label: 'newly created worktree',
      reason: 'worktree_not_preexisting',
      overrides: { lookup: { preExisting: false } }
    },
    {
      label: 'non-disposable worktree',
      reason: 'worktree_not_disposable',
      overrides: { lookup: { disposable: false } }
    },
    {
      label: 'mutable lookup path',
      reason: 'path_mismatch',
      overrides: { lookup: { path: '/private/tmp/orca-lab/other-worktree' } }
    },
    {
      label: 'symlinked real path',
      reason: 'realpath_mismatch',
      overrides: { realpath: { canonicalPath: '/private/tmp/orca-lab/other-worktree' } }
    },
    {
      label: 'missing real path',
      reason: 'path_unavailable',
      overrides: { realpath: { state: 'missing' as const } }
    },
    {
      label: 'unavailable Git evidence',
      reason: 'git_evidence_unavailable',
      overrides: { git: { state: 'unavailable' as const } }
    },
    {
      label: 'repository pin drift',
      reason: 'git_repository_mismatch',
      overrides: {
        git: {
          repositoryRoot: { pinned: WORKTREE_PATH, observed: '/private/tmp/orca-lab/other' }
        }
      }
    },
    {
      label: 'common-directory pin drift',
      reason: 'git_common_directory_mismatch',
      overrides: {
        git: {
          commonDirectory: { pinned: COMMON_DIRECTORY, observed: `${COMMON_DIRECTORY}-other` }
        }
      }
    },
    {
      label: 'HEAD pin drift',
      reason: 'git_head_mismatch',
      overrides: { git: { headCommit: { pinned: HEAD_COMMIT, observed: '3'.repeat(40) } } }
    },
    {
      label: 'tree pin drift',
      reason: 'git_tree_mismatch',
      overrides: { git: { treeHash: { pinned: TREE_HASH, observed: '4'.repeat(40) } } }
    },
    {
      label: 'dirty tree',
      reason: 'worktree_dirty',
      overrides: { git: { statusPorcelainV2: '1 .M N... 100644 file.txt' } }
    }
  ])('refuses $label', ({ reason, overrides }) => {
    expect(() => verify(overrides)).toThrowError(
      expect.objectContaining({
        code: LAB_WORKTREE_OBSERVATION_REFUSAL_CODE,
        data: expect.objectContaining({ reason })
      })
    )
  })

  it('requires the admission object itself to be frozen', () => {
    const dbAction = vi.fn()
    const providerAction = vi.fn()

    expect(() => {
      const verified = verifyLabWorktreeObservation({
        admission: { ...ADMISSION },
        evidence: evidence()
      })
      dbAction(verified.receipt)
      providerAction(verified.observation)
    }).toThrowError(
      expect.objectContaining({
        code: LAB_WORKTREE_OBSERVATION_REFUSAL_CODE,
        data: expect.objectContaining({ reason: 'admission_not_frozen' })
      })
    )
    expect(dbAction).not.toHaveBeenCalled()
    expect(providerAction).not.toHaveBeenCalled()
  })
})

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
