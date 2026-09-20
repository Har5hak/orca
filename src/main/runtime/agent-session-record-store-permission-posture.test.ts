import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSessionRecordStore } from './agent-session-record-store'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-posture-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('durable agent-session permission posture', () => {
  it('survives a store reopen', async () => {
    const first = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await first.reserveOwner({
      sessionId: 'session-posture',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
      requiredPermissionPosture: 'manual',
      runtimeKind: 'native',
      expectedFence: null,
      spawnToken: 'spawn-token',
      claimKeyId: 'claim-key',
      handoffOperationId: null,
      probe: { outcome: 'indeterminate', reason: 'test fixture' },
      operation: {
        callerKey: 'test-caller',
        operationId: '1800000000000-00000000000000000000000000000001',
        fingerprint: 'test-fingerprint'
      },
      now: 1_800_000_000_000
    })

    const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(reopened.getRecord('session-posture')?.requiredPermissionPosture).toBe('manual')
  })
})
