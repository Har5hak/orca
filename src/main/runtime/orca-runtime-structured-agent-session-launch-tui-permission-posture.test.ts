import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { StructuredAgentSessionHandoffTransport } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { OrcaRuntimeService } from './orca-runtime'

class HandoffTestRuntime extends OrcaRuntimeService {
  createTestHandoffTransport(): StructuredAgentSessionHandoffTransport {
    return this.createStructuredAgentSessionHandoffTransport()
  }
}

describe('structured session TUI handoff permission posture', () => {
  it('refuses before spawn when the constrained posture cannot be preserved by the TUI route', async () => {
    const runtime = new HandoffTestRuntime()
    const ensureAgentSession = vi.spyOn(runtime, 'ensureAgentSession')
    const record: AgentSessionRecord = {
      schemaVersion: 2,
      sessionId: 'session-1',
      location: {
        workspaceId: 'repo::worktree',
        executionHostId: 'local',
        wslDistro: null,
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/tmp/codex-home' },
      requiredPermissionPosture: 'manual',
      providerHandleChain: [
        {
          linkId: 'thread-1',
          handle: { provider: 'codex', threadId: 'thread-1' },
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1,
      lease: {
        sessionId: 'session-1',
        runtimeKind: 'native',
        runtimeFence: 1,
        handoffStage: null,
        provenHandleLinkId: null,
        ownerProcess: null,
        reservedSpawnToken: null,
        leaseDeadlineAt: 31_000,
        lastRenewedAt: 1,
        handoffOperationId: null,
        journalCheckpoint: null,
        claimKeyId: 'test-claim',
        claimStatus: 'reserved',
        unreconciled: false,
        deathEvidence: null
      }
    }
    const transport = runtime.createTestHandoffTransport()

    await expect(
      transport.launchTui({
        record,
        fence: 1,
        spawnToken: 'spawn-token'
      })
    ).rejects.toThrow('agent_session_permission_posture_tui_handoff_unsupported')
    expect(ensureAgentSession).not.toHaveBeenCalled()
  })
})
