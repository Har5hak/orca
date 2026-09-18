import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  testCodexLabDynamicToolGatewayBinding,
  testCodexLabDynamicToolHost,
  testCodexLabDynamicToolHostAttestation
} from '../runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import type {
  CodexLabDynamicToolHostPort,
  CodexLabDynamicToolResponse
} from './codex-lab-dynamic-tool-host'
import { CODEX_DYNAMIC_TOOL_CALL_METHOD } from './codex-server-request-disposition'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { deliverCodexServerRequest } from './codex-structured-provider-events'
import {
  closeCodexPublishedSession,
  handleCodexSessionExit
} from './codex-structured-session-close'
import { CodexPromptRegistry } from './codex-structured-prompt-replies'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import {
  testCodexLabAccount,
  testCodexLabEffectiveConfig,
  testCodexLabExternalChatGptAuth,
  testCodexLabOpenedThread,
  testCodexLabPermissionProfiles,
  testCodexLabRateLimits
} from './codex-lab-session-attestation-test-support'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'
import { codexLabCapacityPolicy } from '../runtime/orchestration/lab-profile/codex-lab-usage-authorization'

const SESSION_ID = 'session-lab'
const THREAD_ID = 'thread-lab'
const TURN_ID = 'turn-active'
const INVALID_HOST_INVOCATION = Object.freeze({
  callId: '../disposed',
  namespace: null,
  tool: 'orca_worker_status',
  arguments: {}
})

const SUCCESS_RESPONSE = Object.freeze({
  contentItems: Object.freeze([
    Object.freeze({ type: 'inputText' as const, text: '{"ok":true,"result":{"ready":true}}' })
  ] as const),
  success: true
})
const REPLAY_RESPONSE = Object.freeze({
  contentItems: Object.freeze([
    Object.freeze({ type: 'inputText' as const, text: '{"ok":false,"reason":"call_replayed"}' })
  ] as const),
  success: false
})

function connection(): CodexAppServerConnection {
  return {
    pid: 757,
    closed: false,
    request: async () => ({}),
    notify: () => {},
    respond: vi.fn(),
    respondWithError: vi.fn(),
    close: vi.fn(async () => true)
  }
}

function host(invoke: CodexLabDynamicToolHostPort['invoke'] = async () => SUCCESS_RESPONSE) {
  return {
    invoke: vi.fn(invoke),
    dispose: vi.fn<() => void>()
  } satisfies CodexLabDynamicToolHostPort
}

function session(input: {
  host?: CodexLabDynamicToolHostPort
  connection?: CodexAppServerConnection
  workerAccessMode?: 'orca-cli' | 'lab-gateway'
  ended?: boolean
}): CodexSession {
  return {
    connection: input.connection ?? connection(),
    ended: input.ended ?? false,
    requestedClose: false,
    fence: 7,
    acquisitionGeneration: 'generation-757',
    threadId: THREAD_ID,
    historyPath: null,
    activeTurnIds: new Set([TURN_ID]),
    workerAccessMode: input.workerAccessMode ?? 'lab-gateway',
    ...(input.host ? { labDynamicToolHost: input.host } : {}),
    prompts: new CodexPromptRegistry(),
    options: new Map(),
    reportedOptions: {},
    fastModeTierByModel: new Map(),
    dispatchEchoes: createCodexDispatchEchoes(),
    translator: null,
    backgroundTasks: new CodexBackgroundTaskTracker(THREAD_ID)
  }
}

function request(
  id: number,
  overrides: Readonly<Record<string, unknown>> = {}
): { id: number; method: string; params: Readonly<Record<string, unknown>> } {
  return {
    id,
    method: CODEX_DYNAMIC_TOOL_CALL_METHOD,
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      callId: 'call_757',
      namespace: null,
      tool: 'orca_worker_status',
      arguments: {},
      ...overrides
    }
  }
}

describe('Codex laboratory dynamic-tool server-request disposition', () => {
  it('journals the exact request before one asynchronous host invocation and relays its response', async () => {
    const order: string[] = []
    const dynamicHost = host(async () => {
      order.push('invoke')
      return SUCCESS_RESPONSE
    })
    const current = session({ host: dynamicHost })
    const emit = vi.fn((_session: CodexSession, event: CodexStructuredSessionEvent) => {
      order.push('journal')
      expect(event).toEqual({
        type: 'server-request',
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        method: CODEX_DYNAMIC_TOOL_CALL_METHOD,
        params: request(1).params
      })
      return { accepted: true as const }
    })

    expect(deliverCodexServerRequest(SESSION_ID, current, request(1), emit)).toEqual({
      accepted: true
    })
    expect(order).toEqual(['journal'])
    expect(dynamicHost.invoke).not.toHaveBeenCalled()

    await vi.waitFor(() =>
      expect(current.connection.respond).toHaveBeenCalledWith(1, SUCCESS_RESPONSE)
    )
    expect(order).toEqual(['journal', 'invoke'])
    expect(dynamicHost.invoke).toHaveBeenCalledOnce()
  })

  it('refuses a failed journal admission, never invokes authority, and starts exact-child recovery', () => {
    const dynamicHost = host()
    const forceCloseUnexpected = vi.fn<(reason: Error) => Promise<boolean>>(async () => true)
    const current = session({ host: dynamicHost })
    current.forceCloseUnexpected = forceCloseUnexpected

    expect(
      deliverCodexServerRequest(SESSION_ID, current, request(2), () => ({
        accepted: false,
        reason: 'backpressure'
      }))
    ).toEqual({ accepted: false, reason: 'backpressure' })
    expect(dynamicHost.invoke).not.toHaveBeenCalled()
    expect(current.connection.respond).toHaveBeenCalledWith(2, {
      contentItems: [],
      success: false
    })
    expect(forceCloseUnexpected).toHaveBeenCalledOnce()
    expect(forceCloseUnexpected.mock.calls[0]?.[0]).toEqual(
      new Error('Codex server request item/tool/call could not be durably recorded (backpressure)')
    )
  })

  it.each([
    ['foreign thread', { threadId: 'thread-foreign' }],
    ['inactive turn', { turnId: 'turn-stale' }],
    ['missing turn', { turnId: undefined }],
    ['non-string call id', { callId: 757 }],
    ['invalid call id', { callId: '../call' }],
    ['foreign namespace', { namespace: 'orca' }],
    ['unknown tool', { tool: 'orca_worker_start' }],
    ['undefined arguments', { arguments: undefined }],
    ['invalid arguments', { arguments: { dispatchId: 'foreign' } }]
  ])('preserves the safe refusal without invoking for %s', async (_case, overrides) => {
    const dynamicHost = host()
    const current = session({ host: dynamicHost })

    deliverCodexServerRequest(SESSION_ID, current, request(3, overrides), () => ({
      accepted: true
    }))

    await Promise.resolve()
    expect(dynamicHost.invoke).not.toHaveBeenCalled()
    expect(current.connection.respond).toHaveBeenCalledWith(3, {
      contentItems: [],
      success: false
    })
  })

  it('refuses an envelope with no arguments field before host invocation', async () => {
    const dynamicHost = host()
    const current = session({ host: dynamicHost })
    const missingArguments = request(30)
    const params = { ...missingArguments.params }
    Reflect.deleteProperty(params, 'arguments')

    deliverCodexServerRequest(SESSION_ID, current, { ...missingArguments, params }, () => ({
      accepted: true
    }))

    await Promise.resolve()
    expect(dynamicHost.invoke).not.toHaveBeenCalled()
    expect(current.connection.respond).toHaveBeenCalledWith(30, {
      contentItems: [],
      success: false
    })
  })

  it('keeps ordinary and ended sessions on the generic safe refusal path', async () => {
    const dynamicHost = host()
    const ordinary = session({ host: dynamicHost, workerAccessMode: 'orca-cli' })
    const ended = session({ host: dynamicHost, ended: true })

    deliverCodexServerRequest(SESSION_ID, ordinary, request(4), () => ({ accepted: true }))
    deliverCodexServerRequest(SESSION_ID, ended, request(5), () => ({ accepted: true }))

    await Promise.resolve()
    expect(dynamicHost.invoke).not.toHaveBeenCalled()
    expect(ordinary.connection.respond).toHaveBeenCalledWith(4, {
      contentItems: [],
      success: false
    })
    expect(ended.connection.respond).toHaveBeenCalledWith(5, {
      contentItems: [],
      success: false
    })
  })

  it('delegates duplicate call identities to the one-shot host without integration retries', async () => {
    const first = Promise.withResolvers<CodexLabDynamicToolResponse>()
    const invoke = vi
      .fn<CodexLabDynamicToolHostPort['invoke']>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(REPLAY_RESPONSE)
    const dynamicHost: CodexLabDynamicToolHostPort = { invoke, dispose: vi.fn() }
    const current = session({ host: dynamicHost })

    deliverCodexServerRequest(SESSION_ID, current, request(6), () => ({ accepted: true }))
    deliverCodexServerRequest(SESSION_ID, current, request(7), () => ({ accepted: true }))

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    expect(current.connection.respond).toHaveBeenCalledWith(7, REPLAY_RESPONSE)
    first.resolve(SUCCESS_RESPONSE)
    await vi.waitFor(() =>
      expect(current.connection.respond).toHaveBeenCalledWith(6, SUCCESS_RESPONSE)
    )
    expect(invoke.mock.calls[0]?.[0]).toEqual(invoke.mock.calls[1]?.[0])
  })

  it('disposes authority only for the exact provider exit and only once', () => {
    const dynamicHost = host()
    const exactConnection = connection()
    const current = session({ host: dynamicHost, connection: exactConnection })
    const sessions = new Map([[SESSION_ID, current]])

    expect(
      handleCodexSessionExit({
        sessions,
        sessionId: SESSION_ID,
        connection: connection(),
        error: new Error('stale provider exited')
      })
    ).toBe(false)
    expect(dynamicHost.dispose).not.toHaveBeenCalled()

    expect(
      handleCodexSessionExit({
        sessions,
        sessionId: SESSION_ID,
        connection: exactConnection,
        error: new Error('exact provider exited')
      })
    ).toBe(true)
    expect(dynamicHost.dispose).toHaveBeenCalledOnce()
    expect(current.labDynamicToolHost).toBeUndefined()

    expect(
      handleCodexSessionExit({
        sessions,
        sessionId: SESSION_ID,
        connection: exactConnection,
        error: new Error('duplicate exit callback')
      })
    ).toBe(false)
    expect(dynamicHost.dispose).toHaveBeenCalledOnce()
  })

  it('disposes authority when an exact requested close proves provider exit', async () => {
    const dynamicHost = host()
    const current = session({ host: dynamicHost })
    const sessions = new Map([[SESSION_ID, current]])

    await expect(closeCodexPublishedSession(sessions, SESSION_ID)).resolves.toBe(true)

    expect(dynamicHost.dispose).toHaveBeenCalledOnce()
    expect(sessions.has(SESSION_ID)).toBe(false)
  })

  it('carries the host-only bridge through lab acquisition and aborts it on provider exit', async () => {
    const gatewayBinding = testCodexLabDynamicToolGatewayBinding()
    const dynamicHost = testCodexLabDynamicToolHost({}, async () => ({
      ok: true,
      result: { ready: true },
      receipt: gatewayBinding.expectedReceipt
    }))
    const exactConnection = connection()
    const expected = Object.freeze({
      cwd: '/private/tmp/orca-lab/disposable-757',
      codexHome: '/private/tmp/orca-lab/homes/session-757/codex-home',
      fakeHome: '/private/tmp/orca-lab/homes/session-757/fake-home',
      gatewaySocketPath: '/private/tmp/orca-lab/homes/session-757/gateway.sock',
      workspaceId: '00000000-0000-4000-8000-000000000757',
      permissionProfileId: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
      capacityPolicy: codexLabCapacityPolicy({
        workspaceId: '00000000-0000-4000-8000-000000000757',
        planType: 'business',
        authorization: null
      })
    })
    const auth = testCodexLabExternalChatGptAuth({
      dispatchId: gatewayBinding.expectedReceipt.dispatchId,
      sessionId: SESSION_ID,
      expected
    })
    exactConnection.request = async (method) => {
      if (method === 'account/login/start') {
        return { type: 'chatgptAuthTokens' }
      }
      if (method === 'thread/start') {
        return testCodexLabOpenedThread(expected, true, THREAD_ID)
      }
      if (method === 'account/read') {
        return testCodexLabAccount(expected)
      }
      if (method === 'account/rateLimits/read') {
        return testCodexLabRateLimits(expected)
      }
      if (method === 'config/read') {
        return { config: testCodexLabEffectiveConfig(expected), origins: {}, layers: [] }
      }
      if (method === 'configRequirements/read') {
        return { requirements: null }
      }
      if (method === 'permissionProfile/list') {
        return testCodexLabPermissionProfiles(expected)
      }
      throw new Error(`unexpected laboratory request: ${method}`)
    }
    let handlers: CodexAppServerConnectionHandlers = {}
    const openConnection: typeof openCodexAppServerConnection = async (
      _launch,
      nextHandlers = {}
    ) => {
      handlers = nextHandlers
      return exactConnection
    }
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: expected.cwd,
        codexHome: expected.codexHome,
        resumeThreadId: null,
        env: { CODEX_HOME: expected.codexHome, HOME: expected.fakeHome },
        environmentMode: 'exact',
        workerAccessMode: 'lab-gateway',
        labAppServerAttestationExpected: expected,
        labDynamicToolHostAttestationExpected: testCodexLabDynamicToolHostAttestation(),
        labExternalChatGptAuthHost: auth.host,
        labExternalChatGptAuthBindingExpected: auth.binding,
        permissionPolicy: {
          approvalPolicy: 'never',
          permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
          runtimeWorkspaceRoots: [expected.cwd]
        },
        labDynamicToolHost: dynamicHost
      }),
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const identity: AgentSessionJournalIdentity = {
      sessionId: SESSION_ID,
      workspaceId: 'workspace-lab',
      hostId: 'host-lab',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD_ID }
    }

    await adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-lab-757' })
    handlers.onNotification?.('turn/started', {
      threadId: THREAD_ID,
      turn: { id: TURN_ID }
    })
    handlers.onServerRequest?.(request(31))

    await vi.waitFor(() =>
      expect(exactConnection.respond).toHaveBeenCalledWith(31, SUCCESS_RESPONSE)
    )
    handlers.onExit?.(new Error('provider exited'))
    await expect(dynamicHost.invoke(INVALID_HOST_INVOCATION)).resolves.toMatchObject({
      contentItems: [{ text: expect.stringContaining('host_disposed') }]
    })
  })

  it('rejects a host on an ordinary launch and disposes it exactly once before spawn', async () => {
    const dynamicHost = host()
    const openConnection = vi.fn<typeof openCodexAppServerConnection>()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/repos/ordinary',
        codexHome: '/homes/ordinary',
        resumeThreadId: null,
        workerAccessMode: 'orca-cli',
        labDynamicToolHost: dynamicHost
      }),
      openConnection
    })

    await expect(
      adapter.acquire({
        identity: {
          sessionId: 'session-ordinary-host-smuggle',
          workspaceId: 'workspace-ordinary',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: 'thread-ordinary' }
        },
        fence: 1,
        spawnToken: 'spawn-ordinary'
      })
    ).rejects.toThrow(/dynamic tools require lab-gateway/i)

    expect(openConnection).not.toHaveBeenCalled()
    expect(dynamicHost.dispose).toHaveBeenCalledOnce()
  })

  it('rejects lab-gateway access with no dynamic-tool host before spawn', async () => {
    const openConnection = vi.fn<typeof openCodexAppServerConnection>()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/private/tmp/orca-lab/disposable-missing-host',
        codexHome: '/private/tmp/orca-lab/runtime/missing-host/codex-home',
        resumeThreadId: null,
        workerAccessMode: 'lab-gateway'
      }),
      openConnection
    })

    await expect(
      adapter.acquire({
        identity: {
          sessionId: 'session-lab-missing-host',
          workspaceId: 'workspace-lab-missing-host',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: 'thread-lab-missing-host' }
        },
        fence: 1,
        spawnToken: 'spawn-lab-missing-host'
      })
    ).rejects.toThrow(/gateway access requires a dynamic-tool host/i)

    expect(openConnection).not.toHaveBeenCalled()
  })

  it('rejects a structurally forged lab host before spawn', async () => {
    const dynamicHost = host()
    const openConnection = vi.fn<typeof openCodexAppServerConnection>()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/private/tmp/orca-lab/disposable-forged-host',
        codexHome: '/private/tmp/orca-lab/runtime/forged-host/codex-home',
        resumeThreadId: null,
        workerAccessMode: 'lab-gateway',
        labDynamicToolHost: dynamicHost,
        labDynamicToolHostAttestationExpected: testCodexLabDynamicToolHostAttestation()
      }),
      openConnection
    })

    await expect(
      adapter.acquire({
        identity: {
          sessionId: 'session-lab-forged-host',
          workspaceId: 'workspace-lab-forged-host',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: 'thread-lab-forged-host' }
        },
        fence: 1,
        spawnToken: 'spawn-lab-forged-host'
      })
    ).rejects.toThrow(/gateway access requires a dynamic-tool host/i)

    expect(openConnection).not.toHaveBeenCalled()
    expect(dynamicHost.dispose).toHaveBeenCalledOnce()
  })

  it('rejects a branded host bound to a different Dispatch before spawn', async () => {
    const dynamicHost = testCodexLabDynamicToolHost()
    const openConnection = vi.fn<typeof openCodexAppServerConnection>()
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/private/tmp/orca-lab/disposable-foreign-host',
        codexHome: '/private/tmp/orca-lab/runtime/foreign-host/codex-home',
        resumeThreadId: null,
        workerAccessMode: 'lab-gateway',
        labDynamicToolHost: dynamicHost,
        labDynamicToolHostAttestationExpected: testCodexLabDynamicToolHostAttestation({
          dispatchId: 'dispatch-foreign'
        })
      }),
      openConnection
    })

    await expect(
      adapter.acquire({
        identity: {
          sessionId: 'session-lab-foreign-host',
          workspaceId: 'workspace-lab-foreign-host',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: 'thread-lab-foreign-host' }
        },
        fence: 1,
        spawnToken: 'spawn-lab-foreign-host'
      })
    ).rejects.toThrow(/gateway access requires a dynamic-tool host/i)

    expect(openConnection).not.toHaveBeenCalled()
    await expect(dynamicHost.invoke(INVALID_HOST_INVOCATION)).resolves.toMatchObject({
      contentItems: [{ text: expect.stringContaining('host_disposed') }]
    })
  })

  it('disposes a lab host exactly once when acquisition fails before publication', async () => {
    const dynamicHost = testCodexLabDynamicToolHost()
    const expected = Object.freeze({
      cwd: '/private/tmp/orca-lab/disposable-failure',
      codexHome: '/private/tmp/orca-lab/runtime/failure/codex-home',
      fakeHome: '/private/tmp/orca-lab/runtime/failure/fake-home',
      gatewaySocketPath: '/private/tmp/orca-lab/runtime/failure/gateway.sock',
      workspaceId: '00000000-0000-4000-8000-000000000757',
      permissionProfileId: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
      capacityPolicy: codexLabCapacityPolicy({
        workspaceId: '00000000-0000-4000-8000-000000000757',
        planType: 'business',
        authorization: null
      })
    })
    const openConnection = vi.fn<typeof openCodexAppServerConnection>(async () => {
      throw new Error('injected pre-publication open failure')
    })
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: expected.cwd,
        codexHome: expected.codexHome,
        resumeThreadId: null,
        env: { CODEX_HOME: expected.codexHome, HOME: expected.fakeHome },
        environmentMode: 'exact',
        workerAccessMode: 'lab-gateway',
        labDynamicToolHost: dynamicHost,
        labDynamicToolHostAttestationExpected: testCodexLabDynamicToolHostAttestation(),
        labAppServerAttestationExpected: expected,
        permissionPolicy: {
          approvalPolicy: 'never',
          permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
          runtimeWorkspaceRoots: [expected.cwd]
        }
      }),
      openConnection
    })

    await expect(
      adapter.acquire({
        identity: {
          sessionId: 'session-lab-open-failure',
          workspaceId: 'workspace-lab-failure',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: 'thread-lab-failure' }
        },
        fence: 1,
        spawnToken: 'spawn-lab-failure'
      })
    ).rejects.toThrow('injected pre-publication open failure')

    expect(openConnection).toHaveBeenCalledOnce()
    await expect(dynamicHost.invoke(INVALID_HOST_INVOCATION)).resolves.toMatchObject({
      contentItems: [{ text: expect.stringContaining('host_disposed') }]
    })
  })
})
