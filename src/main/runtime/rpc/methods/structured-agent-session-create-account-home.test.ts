import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../../shared/agent-session-wire'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import { OrcaRuntimeService } from '../../orca-runtime'
import { prepareStructuredAgentSessionCreateForWorktree } from './structured-agent-session-create'

const ENVELOPE: AgentSessionMutationEnvelope = {
  sessionId: 'session-lab-home',
  clientOperationId: 'operation-lab-home',
  expectedRuntimeFence: null,
  payloadFingerprint: ''
}

function resolvedIntent(accountHomePath: string): AgentSessionAttachParams {
  return {
    envelope: ENVELOPE,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'worktree-id',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: accountHomePath },
    runtimeKind: 'native'
  }
}

async function prepare(accountHomePathOverride?: string) {
  const runtime = new OrcaRuntimeService()
  const resolved = resolvedIntent('/ambient/.codex')
  vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockResolvedValue(resolved)
  const prepared = await prepareStructuredAgentSessionCreateForWorktree({
    runtime,
    ensureHost: vi.fn(),
    envelope: ENVELOPE,
    worktree: 'id:worktree-id',
    agent: 'codex',
    caller: { callerKey: 'trusted-local:test' },
    ...(accountHomePathOverride ? { accountHomePathOverride } : {})
  })
  return { prepared, resolved }
}

describe('structured session account home selection', () => {
  it('fingerprints and attaches the host-selected sealed laboratory home', async () => {
    const sealedHome =
      '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-account-home/codex-home'
    const { prepared, resolved } = await prepare(sealedHome)
    const expectedFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId: ENVELOPE.sessionId,
      fields: attachFingerprintFields({
        ...resolved,
        accountHome: { variable: 'CODEX_HOME', path: sealedHome }
      })
    })

    expect(prepared.attachParams.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: sealedHome
    })
    expect(prepared.attachParams.envelope.payloadFingerprint).toBe(expectedFingerprint)
  })

  it('keeps ordinary structured session account-home selection unchanged', async () => {
    const { prepared } = await prepare()

    expect(prepared.attachParams.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/ambient/.codex'
    })
  })
})
