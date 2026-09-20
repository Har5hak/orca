import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../../../../shared/agent-session-record.test-fixture'
import type { AgentSessionAttachParams } from '../../../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { WorkerStartInput } from './worker-start-schema'
import {
  STRUCTURED_WRITE_PROFILE_ID,
  assertWorkerExecutionProfileMode,
  profileStartOptions,
  resolveWorkerStartExecutionProfile,
  validatePersistedWorkerExecutionProfile,
  validatePreparedWorkerExecutionProfile
} from './worker-start-execution-profile'

const VALID_INPUT = {
  task: 'task_1',
  from: 'term_coord',
  profile: STRUCTURED_WRITE_PROFILE_ID,
  agent: 'codex',
  worktree: 'new-child',
  name: 'canary-worker',
  setup: 'skip'
} satisfies WorkerStartInput

function resolve(overrides: Partial<WorkerStartInput> = {}) {
  return resolveWorkerStartExecutionProfile({ ...VALID_INPUT, ...overrides })
}

function expectRefusal(overrides: Partial<WorkerStartInput>, reason: string): void {
  expect(() => resolve(overrides)).toThrowError(
    expect.objectContaining({
      code: 'execution_profile_refused',
      data: expect.objectContaining({ reason })
    })
  )
}

describe('structured-write-v1 admission', () => {
  it('admits exactly one local Codex child-worktree worker with setup disabled', () => {
    const admission = resolve()

    expect(admission).toEqual({
      id: STRUCTURED_WRITE_PROFILE_ID,
      maxConcurrency: 1,
      agent: 'codex',
      requiredPermissionPosture: 'manual',
      nestedWorkerStarts: 'forbidden'
    })
    expect(profileStartOptions(admission!)).toEqual({
      id: STRUCTURED_WRITE_PROFILE_ID,
      maxConcurrency: 1,
      agent: 'codex',
      permissionPosture: { required: 'manual' },
      nestedWorkerStarts: 'forbidden',
      worktree: { requested: 'new-child' },
      setup: 'skip'
    })
  })

  it('leaves an ordinary worker unchanged when no profile was requested', () => {
    expect(resolveWorkerStartExecutionProfile({ ...VALID_INPUT, profile: undefined })).toBeNull()
  })

  it.each([
    ['unknown profile', { profile: 'future-profile' }, 'profile_unsupported'],
    ['Claude', { agent: 'claude' }, 'provider_unsupported'],
    ['remote host', { on: 'build-box' }, 'execution_host_unsupported'],
    ['reused terminal', { terminal: 'term_existing' }, 'execution_host_unsupported'],
    ['current worktree', { worktree: 'current' }, 'worktree_selector_required'],
    ['unnamed child', { name: undefined }, 'worktree_selector_required'],
    ['another repository', { repo: 'id:other' }, 'cross_repo_forbidden'],
    ['setup enabled', { setup: 'run' }, 'setup_forbidden'],
    ['setup implicit', { setup: undefined }, 'setup_forbidden']
  ] as const)('refuses %s', (_name, overrides, reason) => {
    expectRefusal(overrides, reason)
  })

  it('fails closed instead of downgrading to a terminal agent', () => {
    const admission = resolve()!
    expect(() =>
      assertWorkerExecutionProfileMode(admission, {
        mode: 'terminal',
        reason: 'structured_unsupported_on_host'
      })
    ).toThrowError(
      expect.objectContaining({
        code: 'execution_profile_refused',
        data: { reason: 'structured_session_unavailable' }
      })
    )
  })
})

describe('structured-write-v1 launch evidence', () => {
  const accountHomePath = '/accounts/selected/codex-home'
  const attachParams = {
    envelope: {
      sessionId: 'session_1',
      clientOperationId: 'operation_1',
      expectedRuntimeFence: null,
      payloadFingerprint: 'attach-fingerprint'
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'repo::child',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: accountHomePath },
    requiredPermissionPosture: 'manual',
    runtimeKind: 'native'
  } satisfies AgentSessionAttachParams

  it('attests the resolved worktree and selected account without exposing its path', () => {
    const admission = resolve()!
    const validation = validatePreparedWorkerExecutionProfile({
      admission,
      prepared: { attachParams },
      expectedWorktreeId: 'repo::child'
    })

    expect(validation).toMatchObject({
      id: STRUCTURED_WRITE_PROFILE_ID,
      provider: 'codex',
      permissionPosture: {
        required: 'manual',
        enforcedAt: 'every-provider-acquisition'
      },
      worktree: { requested: 'new-child', resolvedId: 'repo::child' },
      account: {
        route: 'selected-account-home',
        variable: 'CODEX_HOME',
        homeSha256: createHash('sha256').update(accountHomePath).digest('hex')
      },
      attachFingerprint: 'attach-fingerprint'
    })
    expect(JSON.stringify(validation)).not.toContain(accountHomePath)

    expect(
      validatePersistedWorkerExecutionProfile({
        admission,
        validation,
        record: {
          ...agentSessionRecordFixture(),
          sessionId: 'session_1',
          provider: 'codex',
          location: attachParams.location,
          providerHandleChain: [],
          accountHome: attachParams.accountHome,
          requiredPermissionPosture: 'manual'
        }
      })
    ).toBe(validation)
  })

  it('refuses an account-home variable that does not belong to the admitted provider', () => {
    const admission = resolve()!

    expect(() =>
      validatePreparedWorkerExecutionProfile({
        admission,
        prepared: {
          attachParams: {
            ...attachParams,
            accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: accountHomePath }
          }
        },
        expectedWorktreeId: 'repo::child'
      })
    ).toThrowError(expect.objectContaining({ code: 'execution_profile_refused' }))
  })

  it('refuses a persisted record that broadened or moved after preparation', () => {
    const admission = resolve()!
    const validation = validatePreparedWorkerExecutionProfile({
      admission,
      prepared: { attachParams },
      expectedWorktreeId: 'repo::child'
    })

    expect(() =>
      validatePersistedWorkerExecutionProfile({
        admission,
        validation,
        record: {
          ...agentSessionRecordFixture(),
          sessionId: 'session_1',
          provider: 'codex',
          location: { ...attachParams.location, workspaceId: 'repo::other' },
          providerHandleChain: [],
          accountHome: attachParams.accountHome,
          requiredPermissionPosture: 'manual'
        }
      })
    ).toThrowError(expect.objectContaining({ code: 'execution_profile_refused' }))
  })
})
