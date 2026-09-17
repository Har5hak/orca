import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  registerCodexLabStructuredLaunchBinding,
  releaseCodexLabStructuredLaunchBinding
} from '../runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import {
  TEST_LAB_WORKTREE_PATH,
  testCodexLabStructuredLaunchBinding
} from '../runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'

const SESSION_ID = 'session_lab_structured'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

function record(accountHome: string): AgentSessionRecord {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    provider: 'codex',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'worktree-id',
      workspaceKind: 'git-worktree'
    },
    accountHome: { variable: 'CODEX_HOME', path: accountHome },
    providerHandleChain: [],
    lease: {
      sessionId: SESSION_ID,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 1,
      lastRenewedAt: 1,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'test-claim-key',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 1,
    updatedAt: 1
  }
}

describe('structured Codex lab launch resolution', () => {
  it('uses the validated binding and never reads ordinary command, policy, or ambient env', async () => {
    const binding = testCodexLabStructuredLaunchBinding()
    registerCodexLabStructuredLaunchBinding(SESSION_ID, binding)
    const resolveEnvironment = vi.fn(async () => ({
      PATH: '/ambient/bin',
      OPENAI_API_KEY: 'forbidden'
    }))
    const resolveCommand = vi.fn(() => '/ambient/codex')
    const resolvePermissionPolicy = vi.fn(() => ({
      approvalPolicy: 'never' as const,
      sandbox: 'danger-full-access' as const
    }))
    try {
      const resolve = createCodexStructuredLaunchResolver({
        store: { getRecord: () => record(binding.plan.runtimePaths.codexHome) },
        resolveWorkspacePath: async () => TEST_LAB_WORKTREE_PATH,
        resolveEnvironment,
        resolveCommand,
        resolvePermissionPolicy
      })

      await expect(resolve({ identity: IDENTITY })).resolves.toEqual({
        command: binding.plan.executable,
        args: [...binding.plan.argv],
        cwd: TEST_LAB_WORKTREE_PATH,
        codexHome: binding.plan.runtimePaths.codexHome,
        resumeThreadId: null,
        env: {
          CODEX_HOME: binding.plan.runtimePaths.codexHome,
          HOME: binding.plan.runtimePaths.fakeHome
        },
        environmentMode: 'exact',
        permissionPolicy: {
          approvalPolicy: 'never',
          permissions: 'orca-lab-readonly-v1',
          runtimeWorkspaceRoots: [TEST_LAB_WORKTREE_PATH]
        }
      })
      expect(resolveEnvironment).not.toHaveBeenCalled()
      expect(resolveCommand).not.toHaveBeenCalled()
      expect(resolvePermissionPolicy).not.toHaveBeenCalled()
    } finally {
      releaseCodexLabStructuredLaunchBinding(SESSION_ID, binding.dispatchId)
    }
  })

  it('fails closed when the durable record does not match the binding', async () => {
    const binding = testCodexLabStructuredLaunchBinding()
    registerCodexLabStructuredLaunchBinding(SESSION_ID, binding)
    try {
      const resolve = createCodexStructuredLaunchResolver({
        store: { getRecord: () => record('/wrong/codex-home') },
        resolveWorkspacePath: async () => TEST_LAB_WORKTREE_PATH
      })
      await expect(resolve({ identity: IDENTITY })).rejects.toThrow(/lab launch binding/i)
    } finally {
      releaseCodexLabStructuredLaunchBinding(SESSION_ID, binding.dispatchId)
    }
  })

  it('refuses a bound session that could resume an existing provider thread', async () => {
    const binding = testCodexLabStructuredLaunchBinding()
    const durableRecord = record(binding.plan.runtimePaths.codexHome)
    durableRecord.providerHandleChain.push({
      linkId: 'existing-thread',
      handle: { provider: 'codex', threadId: 'thread-existing' },
      origin: 'created',
      mintedAtFence: 1,
      observedAt: 1
    })
    registerCodexLabStructuredLaunchBinding(SESSION_ID, binding)
    try {
      const resolve = createCodexStructuredLaunchResolver({
        store: { getRecord: () => durableRecord },
        resolveWorkspacePath: async () => TEST_LAB_WORKTREE_PATH
      })
      await expect(resolve({ identity: IDENTITY })).rejects.toThrow(/lab launch binding/i)
    } finally {
      releaseCodexLabStructuredLaunchBinding(SESSION_ID, binding.dispatchId)
    }
  })

  it('leaves an ordinary unbound structured chat unchanged', async () => {
    const resolve = createCodexStructuredLaunchResolver({
      store: { getRecord: () => record('/normal/codex-home') },
      resolveWorkspacePath: async () => '/repos/normal',
      resolveEnvironment: async () => ({ PATH: '/normal/bin', NORMAL: 'yes' }),
      resolveCommand: () => '/normal/bin/codex',
      resolvePermissionPolicy: () => ({
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write'
      })
    })

    await expect(resolve({ identity: IDENTITY })).resolves.toEqual({
      command: '/normal/bin/codex',
      args: ['app-server'],
      cwd: '/repos/normal',
      codexHome: '/normal/codex-home',
      env: { PATH: '/normal/bin', NORMAL: 'yes' },
      resumeThreadId: null,
      permissionPolicy: { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    })
  })
})
