import { describe, expect, it } from 'vitest'
import {
  LAB_READONLY_PROFILE_RUNTIME_CAPABILITY,
  WorkerStartParams
} from './orchestration-worker-start-params'

describe('WorkerStartParams lab profile contract', () => {
  it('uses the provider-neutral versioned runtime capability', () => {
    expect(LAB_READONLY_PROFILE_RUNTIME_CAPABILITY).toBe('orchestration.lab-readonly-profile.v1')
  })

  it('preserves the four independently supplied profile admission fields', () => {
    expect(
      WorkerStartParams.parse({
        task: 'task_1',
        from: 'term_coord',
        agent: 'codex',
        profile: 'lab-readonly-supervised-v1',
        adapter: 'codex-workspace-chatgpt-v1',
        worktreeIdentity: 'wt2:local:disposable-instance',
        expectedWorktreePath: '/private/tmp/orca-lab/disposable-worktree'
      })
    ).toMatchObject({
      profile: 'lab-readonly-supervised-v1',
      adapter: 'codex-workspace-chatgpt-v1',
      worktreeIdentity: 'wt2:local:disposable-instance',
      expectedWorktreePath: '/private/tmp/orca-lab/disposable-worktree'
    })
  })
})
