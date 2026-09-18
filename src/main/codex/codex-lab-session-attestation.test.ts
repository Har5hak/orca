import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation'
import {
  testCodexLabDynamicToolHost,
  testCodexLabDynamicToolHostAttestation
} from '../runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import {
  testCodexLabAccount,
  testCodexLabEffectiveConfig,
  testCodexLabOpenedThread,
  testCodexLabPermissionProfiles
} from './codex-lab-session-attestation-test-support'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch,
  type CodexStructuredSessionEvent
} from './codex-structured-session-adapter'

const SESSION_ID = 'session-lab-attested'
const THREAD_ID = 'thread-lab-attested'
const CWD = '/private/tmp/orca-lab/worktrees/dispatch-757'
const EXPECTED: CodexLabAppServerAttestationExpected = Object.freeze({
  cwd: CWD,
  codexHome: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757/codex-home',
  fakeHome: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757/fake-home',
  workspaceId: '00000000-0000-4000-8000-000000000757',
  permissionProfileId: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID
})

type Scenario =
  | 'green'
  | 'account-broadened'
  | 'config-broadened'
  | 'telemetry-broadened'
  | 'profile-broadened'
  | 'thread-request-broadened'
  | 'thread-result-broadened'

type ObservedCall = Readonly<{ method: string; params?: Record<string, unknown> }>

type FakeConnection = CodexAppServerConnection & {
  closed: boolean
  closeCount: number
  calls: ObservedCall[]
  launch: CodexAppServerLaunch
}

function launch(): CodexStructuredLaunch {
  return {
    command: '/usr/local/bin/codex',
    args: ['--strict-config', 'app-server'],
    cwd: EXPECTED.cwd,
    codexHome: EXPECTED.codexHome,
    resumeThreadId: null,
    env: { CODEX_HOME: EXPECTED.codexHome, HOME: EXPECTED.fakeHome },
    environmentMode: 'exact',
    workerAccessMode: 'lab-gateway',
    labDynamicToolHost: testCodexLabDynamicToolHost(),
    labDynamicToolHostAttestationExpected: testCodexLabDynamicToolHostAttestation(),
    labAppServerAttestationExpected: EXPECTED,
    permissionPolicy: {
      approvalPolicy: 'never',
      permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
      runtimeWorkspaceRoots: [EXPECTED.cwd]
    }
  }
}

function identity(): AgentSessionJournalIdentity {
  return {
    sessionId: SESSION_ID,
    workspaceId: EXPECTED.workspaceId,
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
}

function harness(scenario: Scenario): {
  adapter: CodexStructuredSessionAdapter
  connections: FakeConnection[]
  events: CodexStructuredSessionEvent[]
  timeline: string[]
  openConnection: typeof openCodexAppServerConnection
} {
  const connections: FakeConnection[] = []
  const events: CodexStructuredSessionEvent[] = []
  const timeline: string[] = []
  const openConnection: typeof openCodexAppServerConnection = async (
    childLaunch,
    handlers: CodexAppServerConnectionHandlers = {}
  ) => {
    const connection: FakeConnection = {
      launch: childLaunch,
      calls: [],
      closeCount: 0,
      pid: 7_570,
      closed: false,
      request: async (method, params) => {
        connection.calls.push(params ? { method, params } : { method })
        timeline.push(`request:${method}`)
        if (method === 'thread/start') {
          if (scenario === 'thread-request-broadened' && params) {
            params.sandbox = 'danger-full-access'
          }
          handlers.onNotification?.('item/started', {
            threadId: THREAD_ID,
            item: { type: 'agentMessage', id: 'early-attestation-message' }
          })
          return testCodexLabOpenedThread(
            EXPECTED,
            scenario === 'thread-result-broadened',
            THREAD_ID
          )
        }
        if (method === 'account/read') {
          return testCodexLabAccount(
            EXPECTED,
            'chatgpt',
            scenario === 'account-broadened'
              ? '00000000-0000-4000-8000-000000000000'
              : EXPECTED.workspaceId
          )
        }
        if (method === 'config/read') {
          const config = testCodexLabEffectiveConfig(EXPECTED, scenario === 'config-broadened')
          if (scenario === 'telemetry-broadened') {
            config.otel = {
              tool_result: {},
              log_user_prompt: false,
              environment: null,
              exporter: 'none',
              trace_exporter: 'none',
              metrics_exporter: 'otlp-http',
              span_attributes: null,
              tracestate: null
            }
          }
          return {
            config,
            origins: {},
            layers: []
          }
        }
        if (method === 'configRequirements/read') {
          return { requirements: null }
        }
        if (method === 'permissionProfile/list') {
          return testCodexLabPermissionProfiles(EXPECTED, scenario !== 'profile-broadened')
        }
        throw new Error(`unexpected laboratory request: ${method}`)
      },
      notify: vi.fn(),
      respond: vi.fn(),
      respondWithError: vi.fn(),
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => launch(),
    openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    onEvent: (event) => {
      events.push(event)
      timeline.push('event:published')
    },
    requestTimeoutMs: 2_000
  })
  return { adapter, connections, events, timeline, openConnection }
}

describe('Codex laboratory acquisition attestation', () => {
  it('attests the exact fresh thread over the guarded live connection before publication', async () => {
    const { adapter, connections, events, timeline } = harness('green')

    await expect(
      adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-lab-757' })
    ).resolves.toMatchObject({
      process: { pid: 7_570 },
      link: { handle: { provider: 'codex', threadId: THREAD_ID } }
    })

    expect(connections).toHaveLength(1)
    expect(connections[0].calls.map(({ method }) => method)).toEqual([
      'thread/start',
      'account/read',
      'config/read',
      'configRequirements/read',
      'permissionProfile/list'
    ])
    expect(connections[0].calls[0]?.params).toMatchObject({
      cwd: EXPECTED.cwd,
      approvalPolicy: 'never',
      permissions: EXPECTED.permissionProfileId,
      ephemeral: true,
      runtimeWorkspaceRoots: [EXPECTED.cwd]
    })
    expect(events).toHaveLength(1)
    expect(timeline).toEqual([
      'request:thread/start',
      'request:account/read',
      'request:config/read',
      'request:configRequirements/read',
      'request:permissionProfile/list',
      'event:published'
    ])
    expect(connections[0].closeCount).toBe(0)
    await expect(adapter.closeSession(SESSION_ID)).resolves.toBe(true)
    expect(connections[0].closeCount).toBe(1)
  })

  it.each([
    ['account-broadened', 'account_unverified'],
    ['config-broadened', 'effective_config_broadened'],
    ['telemetry-broadened', 'effective_config_broadened'],
    ['profile-broadened', 'permission_profile_denied'],
    ['thread-request-broadened', 'thread_request_unverified'],
    ['thread-result-broadened', 'thread_result_unverified']
  ] satisfies readonly (readonly [Scenario, string])[])(
    'closes and publishes nothing when %s fails attestation',
    async (scenario, reason) => {
      const { adapter, connections, events } = harness(scenario)

      await expect(
        adapter.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-lab-757' })
      ).rejects.toThrow(reason)

      expect(connections).toHaveLength(1)
      expect(connections[0].closeCount).toBe(1)
      expect(events).toEqual([])
      await expect(
        adapter.dispatch({
          sessionId: SESSION_ID,
          clientMessageId: 'client-never-published',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'must fail' }] },
          fence: 7
        })
      ).rejects.toThrow('no live codex app-server')
    }
  )

  it('refuses inconsistent sealed-launch expectations before spawning Codex', async () => {
    const { connections, openConnection } = harness('green')
    const badLaunch = launch()
    badLaunch.env = { CODEX_HOME: EXPECTED.codexHome, HOME: '/real/home' }
    const mismatched = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => badLaunch,
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })

    await expect(
      mismatched.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-lab-757' })
    ).rejects.toThrow('do not match the sealed launch')
    expect(connections).toHaveLength(0)
  })

  it.each(['thread id', 'rollout path'])(
    'refuses a laboratory resume by %s before spawning Codex',
    async (resumeProof) => {
      const { connections, openConnection } = harness('green')
      const resumedLaunch = launch()
      if (resumeProof === 'thread id') {
        resumedLaunch.resumeThreadId = 'thread-existing'
      } else {
        resumedLaunch.resumePath = '/private/tmp/orca-lab/existing-rollout.jsonl'
      }
      const resumed = new CodexStructuredSessionAdapter({
        resolveLaunch: async () => resumedLaunch,
        openConnection,
        readProcessStartTime: async () => 1_700_000_000_000
      })

      await expect(
        resumed.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-lab-757' })
      ).rejects.toThrow('do not match the sealed launch')
      expect(connections).toHaveLength(0)
    }
  )

  it('refuses a self-consistent alternate permission profile before spawning Codex', async () => {
    const { connections, openConnection } = harness('green')
    const broadenedLaunch = launch()
    const alternateProfile = 'orca-lab-broadened-v1'
    broadenedLaunch.labAppServerAttestationExpected = Object.freeze({
      ...EXPECTED,
      permissionProfileId: alternateProfile
    })
    if (!broadenedLaunch.permissionPolicy || !('permissions' in broadenedLaunch.permissionPolicy)) {
      throw new Error('test fixture is missing the laboratory permission policy')
    }
    Reflect.set(broadenedLaunch.permissionPolicy, 'permissions', alternateProfile)
    const broadened = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => broadenedLaunch,
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })

    await expect(
      broadened.acquire({ identity: identity(), fence: 7, spawnToken: 'spawn-lab-757' })
    ).rejects.toThrow('do not match the sealed launch')
    expect(connections).toHaveLength(0)
  })
})
