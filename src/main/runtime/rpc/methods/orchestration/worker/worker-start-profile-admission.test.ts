import { describe, expect, it } from 'vitest'
import { LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY } from '../../../../orchestration/lab-profile/codex-lab-launch-contract'
import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  listLabExecutionProfileAdapters
} from './lab-execution-profile-registry'
import {
  LAB_PROFILE_REFUSAL_CODE,
  resolveWorkerStartProfileAdmission
} from './worker-start-profile-admission'
import type { WorkerStartInput } from './worker-start-schema'

const admitted = {
  task: 'task_1',
  from: 'term_coord',
  agent: 'codex',
  profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
  adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  worktreeIdentity: 'wt2:local:disposable-instance',
  expectedWorktreePath: '/private/tmp/orca-lab/disposable-worktree'
} satisfies WorkerStartInput

describe('worker-start lab profile registry', () => {
  it('allowlists only the versioned Codex workspace adapter', () => {
    const registry = listLabExecutionProfileAdapters()
    expect(registry).toEqual([
      {
        profile: 'lab-readonly-supervised-v1',
        adapter: 'codex-workspace-chatgpt-v1',
        agent: 'codex',
        maxConcurrency: LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY
      }
    ])
    expect(Object.isFrozen(registry)).toBe(true)
    expect(Object.isFrozen(registry[0])).toBe(true)
  })
})

describe('worker-start lab profile admission', () => {
  it('is inert when no profile admission field is supplied', () => {
    expect(
      resolveWorkerStartProfileAdmission({
        task: 'task_1',
        from: 'term_coord',
        agent: 'claude',
        worktree: 'current',
        retryOf: 'ctx_failed'
      })
    ).toBeNull()
  })

  it('returns an immutable resolved admission for the one allowed shape', () => {
    const result = resolveWorkerStartProfileAdmission(admitted)

    expect(result).toEqual({
      profile: 'lab-readonly-supervised-v1',
      adapter: 'codex-workspace-chatgpt-v1',
      agent: 'codex',
      maxConcurrency: LAB_READONLY_SUPERVISED_PROFILE_MAX_CONCURRENCY,
      worktreeIdentity: 'wt2:local:disposable-instance',
      worktreeInstanceId: 'disposable-instance',
      expectedWorktreePath: '/private/tmp/orca-lab/disposable-worktree'
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each([
    ['profile', { profile: undefined }],
    ['adapter', { adapter: undefined }],
    ['worktree identity', { worktreeIdentity: undefined }],
    ['expected worktree path', { expectedWorktreePath: undefined }]
  ] as const)('refuses an incomplete admission missing its %s', (_label, override) => {
    expect(() => resolveWorkerStartProfileAdmission({ ...admitted, ...override })).toThrowError(
      expect.objectContaining({
        code: LAB_PROFILE_REFUSAL_CODE,
        data: { reason: 'profile_request_incomplete' }
      })
    )
  })

  it.each([
    ['unsupported profile', { profile: 'lab-readonly-supervised-v2' }, 'profile_unsupported'],
    ['unsupported adapter', { adapter: 'claude-workspace-v1' }, 'adapter_unsupported'],
    ['unsupported provider', { agent: 'claude' }, 'provider_unsupported']
  ] as const)('refuses an %s', (_label, override, reason) => {
    expect(() => resolveWorkerStartProfileAdmission({ ...admitted, ...override })).toThrowError(
      expect.objectContaining({ code: LAB_PROFILE_REFUSAL_CODE, data: { reason } })
    )
  })

  it.each([
    ['current worktree', 'worktree', 'current'],
    ['active worktree', 'worktree', 'active'],
    ['mutable id selector', 'worktree', 'id:repo_1::/private/tmp/worktree'],
    ['path selector', 'worktree', 'path:/private/tmp/worktree'],
    ['branch selector', 'worktree', 'branch:main'],
    ['folder selector', 'worktree', 'folder:folder_1'],
    ['identity through the mutable selector door', 'worktree', 'identity:wt2%3Alocal%3Aother'],
    ['child creation', 'worktree', 'new-child'],
    ['top-level creation', 'worktree', 'new-top-level'],
    ['creation name', 'name', 'disposable'],
    ['creation repository', 'repo', 'id:repo_1'],
    ['creation base branch', 'baseBranch', 'main'],
    ['creation display name', 'displayName', 'Disposable worker'],
    ['creation comment', 'comment', 'create it'],
    ['setup policy', 'setup', 'skip'],
    ['remote server', 'on', 'remote-mac'],
    ['retry dispatch', 'retryOf', 'ctx_failed'],
    ['existing terminal', 'terminal', 'term_existing']
  ] as const)('refuses the %s selector before side effects', (_label, field, value) => {
    expect(() => resolveWorkerStartProfileAdmission({ ...admitted, [field]: value })).toThrowError(
      expect.objectContaining({
        code: LAB_PROFILE_REFUSAL_CODE,
        data: { reason: 'selector_forbidden', field }
      })
    )
  })

  it.each([
    ['legacy mutable id', 'repo_1::/private/tmp/worktree'],
    ['remote host', 'wt2:ssh%3Abuilder:disposable-instance'],
    ['empty instance', 'wt2:local:'],
    ['non-canonical encoding', 'wt2:local:disposable%2finstance'],
    ['extra component', 'wt2:local:disposable:instance']
  ])('refuses a %s worktree identity', (_label, worktreeIdentity) => {
    expect(() =>
      resolveWorkerStartProfileAdmission({ ...admitted, worktreeIdentity })
    ).toThrowError(
      expect.objectContaining({
        code: LAB_PROFILE_REFUSAL_CODE,
        data: { reason: 'worktree_identity_invalid' }
      })
    )
  })

  it.each([
    ['relative', 'tmp/orca-lab/disposable-worktree'],
    ['dot segment', '/private/tmp/orca-lab/../disposable-worktree'],
    ['trailing separator', '/private/tmp/orca-lab/disposable-worktree/']
  ])('refuses a %s expected path', (_label, expectedWorktreePath) => {
    expect(() =>
      resolveWorkerStartProfileAdmission({ ...admitted, expectedWorktreePath })
    ).toThrowError(
      expect.objectContaining({
        code: LAB_PROFILE_REFUSAL_CODE,
        data: { reason: 'expected_path_invalid' }
      })
    )
  })
})
