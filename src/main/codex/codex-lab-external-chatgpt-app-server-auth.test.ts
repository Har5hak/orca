import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  testCodexLabDynamicToolHost,
  testCodexLabDynamicToolHostAttestation
} from '../runtime/orchestration/lab-profile/codex-lab-structured-launch-binding-test-support'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import {
  authenticateCodexLabExternalChatGptAppServer,
  tryRespondToCodexLabExternalChatGptRefresh
} from './codex-lab-external-chatgpt-app-server-auth'
import {
  createCodexLabExternalChatGptAuthHostFactory,
  type CodexLabExternalChatGptAuthBinding,
  type CodexLabExternalChatGptAuthHostPort
} from './codex-lab-external-chatgpt-auth-authority'
import {
  bindCodexLabExternalChatGptAuthHostFactory,
  claimCodexLabExternalChatGptAuthHostFactory
} from './codex-lab-external-chatgpt-auth-authority-internal'
import { CODEX_AUTH_TOKEN_REFRESH_METHOD } from './codex-server-request-disposition'
import {
  testCodexLabAccount,
  testCodexLabEffectiveConfig,
  testCodexLabOpenedThread,
  testCodexLabPermissionProfiles
} from './codex-lab-session-attestation-test-support'
import { adapterFor, fakeCodex, identityFor } from './codex-structured-session-adapter-fixture'
import type {
  CodexStructuredLaunch,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'
import { CODEX_LAB_READONLY_PERMISSION_PROFILE_ID } from './codex-structured-permission-policy'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000757'
const SESSION_ID = 'session-lab-external-auth'
const BINDING: CodexLabExternalChatGptAuthBinding = Object.freeze({
  dispatchId: 'dispatch-lab-external-auth',
  sessionId: SESSION_ID,
  workspaceId: WORKSPACE_ID
})
const liveHosts = new Set<CodexLabExternalChatGptAuthHostPort>()

afterEach(() => {
  for (const host of liveHosts) {
    host.dispose()
  }
  liveHosts.clear()
})

function jwt(label: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', label })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600, label })
  ).toString('base64url')
  return `${header}.${payload}.signature`
}

function authHost(
  input: {
    binding?: CodexLabExternalChatGptAuthBinding
    initial?: string
    refreshed?: string
    refresh?: (candidate: unknown) => Promise<unknown>
  } = {}
): { host: CodexLabExternalChatGptAuthHostPort; refreshSource: ReturnType<typeof vi.fn> } {
  const binding = input.binding ?? BINDING
  const initial = input.initial ?? jwt('initial')
  const refreshed = input.refreshed ?? jwt('refreshed')
  const refreshSource = vi.fn(
    input.refresh ??
      (async () => ({
        accessToken: refreshed,
        chatgptAccountId: binding.workspaceId,
        chatgptPlanType: 'business'
      }))
  )
  const factory = createCodexLabExternalChatGptAuthHostFactory({
    binding,
    credential: {
      type: 'chatgptAuthTokens',
      accessToken: initial,
      chatgptAccountId: binding.workspaceId,
      chatgptPlanType: 'business'
    },
    refresh: refreshSource
  })
  expect(bindCodexLabExternalChatGptAuthHostFactory(factory, binding)).toBe(true)
  const host = claimCodexLabExternalChatGptAuthHostFactory(factory, binding)
  if (!host) {
    throw new Error('test external-auth host was not claimed')
  }
  liveHosts.add(host)
  return { host, refreshSource }
}

function connection(result: unknown = { type: 'chatgptAuthTokens' }): {
  value: CodexAppServerConnection
  request: ReturnType<typeof vi.fn<CodexAppServerConnection['request']>>
  respond: ReturnType<typeof vi.fn<CodexAppServerConnection['respond']>>
  respondWithError: ReturnType<typeof vi.fn<CodexAppServerConnection['respondWithError']>>
} {
  const request = vi.fn<CodexAppServerConnection['request']>(async () => result)
  const respond = vi.fn<CodexAppServerConnection['respond']>()
  const respondWithError = vi.fn<CodexAppServerConnection['respondWithError']>()
  return {
    value: {
      pid: 757,
      closed: false,
      request,
      notify: vi.fn(),
      respond,
      respondWithError,
      close: vi.fn(async () => true)
    },
    request,
    respond,
    respondWithError
  }
}

function labLaunch(
  host: CodexLabExternalChatGptAuthHostPort,
  overrides: {
    authBinding?: CodexLabExternalChatGptAuthBinding
    dynamicDispatchId?: string
    attestedWorkspaceId?: string
  } = {}
): Partial<CodexStructuredLaunch> {
  const authBinding = overrides.authBinding ?? BINDING
  const dynamicDispatchId = overrides.dynamicDispatchId ?? authBinding.dispatchId
  const expected = Object.freeze({
    cwd: '/private/tmp/orca-lab/worktrees/external-auth',
    codexHome: '/private/tmp/orca-lab/runtime/dispatches/external-auth/codex-home',
    fakeHome: '/private/tmp/orca-lab/runtime/dispatches/external-auth/fake-home',
    workspaceId: overrides.attestedWorkspaceId ?? authBinding.workspaceId,
    permissionProfileId: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID
  })
  return {
    cwd: expected.cwd,
    codexHome: expected.codexHome,
    env: { CODEX_HOME: expected.codexHome, HOME: expected.fakeHome },
    environmentMode: 'exact',
    workerAccessMode: 'lab-gateway',
    labDynamicToolHost: testCodexLabDynamicToolHost({ dispatchId: dynamicDispatchId }),
    labDynamicToolHostAttestationExpected: testCodexLabDynamicToolHostAttestation({
      dispatchId: dynamicDispatchId
    }),
    labAppServerAttestationExpected: expected,
    labExternalChatGptAuthHost: host,
    labExternalChatGptAuthBindingExpected: authBinding,
    permissionPolicy: {
      approvalPolicy: 'never',
      permissions: CODEX_LAB_READONLY_PERMISSION_PROFILE_ID,
      runtimeWorkspaceRoots: [expected.cwd]
    }
  }
}

describe('Codex laboratory external ChatGPT app-server auth', () => {
  it('sends the exact token login request and accepts only the exact own-data success shape', async () => {
    const token = jwt('login')
    const { host } = authHost({ initial: token })
    const transport = connection(Object.assign(Object.create(null), { type: 'chatgptAuthTokens' }))

    await expect(
      authenticateCodexLabExternalChatGptAppServer(transport.value, host, 757)
    ).resolves.toBeUndefined()
    expect(transport.request).toHaveBeenCalledWith(
      'account/login/start',
      {
        type: 'chatgptAuthTokens',
        accessToken: token,
        chatgptAccountId: WORKSPACE_ID,
        chatgptPlanType: 'business'
      },
      { timeoutMs: 757 }
    )
  })

  it.each([
    ['wrong type', { type: 'chatgpt' }],
    ['extra field', { type: 'chatgptAuthTokens', persisted: true }],
    ['missing field', {}],
    ['array', [{ type: 'chatgptAuthTokens' }]],
    ['inherited field', Object.create({ type: 'chatgptAuthTokens' })],
    [
      'accessor field',
      Object.defineProperty({}, 'type', {
        enumerable: true,
        get: () => 'chatgptAuthTokens'
      })
    ]
  ])('rejects a %s login response without exposing the token', async (_case, result) => {
    const token = jwt(`rejected-${_case}`)
    const { host } = authHost({ initial: token })

    const operation = authenticateCodexLabExternalChatGptAppServer(connection(result).value, host)
    await expect(operation).rejects.toThrow('external ChatGPT login response is invalid')
    await expect(operation).rejects.not.toThrow(token)
  })

  it('replaces a token-reflecting app-server login rejection with a secret-free error', async () => {
    const token = jwt('login-rejected')
    const { host } = authHost({ initial: token })
    const transport = connection()
    transport.request.mockRejectedValueOnce(new Error(`provider reflected ${token}`))

    const operation = authenticateCodexLabExternalChatGptAppServer(transport.value, host)

    await expect(operation).rejects.toThrow('Codex laboratory external ChatGPT login failed')
    await expect(operation).rejects.not.toThrow(token)
    expect(transport.respond).not.toHaveBeenCalled()
  })

  it('reaps a child after login rejection and disposes auth only on observed exit', async () => {
    const { host, refreshSource } = authHost()
    const codex = fakeCodex({
      'account/login/start': () => {
        throw new Error('provider refused token login')
      }
    })
    const openConnection = codex.openConnection
    codex.openConnection = async (launch, handlers = {}, spawnImpl) => {
      const opened = await openConnection(launch, handlers, spawnImpl)
      const close = opened.close
      opened.close = async () => {
        const exited = await close()
        handlers.onExitObserved?.()
        return exited
      }
      return opened
    }
    const adapter = adapterFor(codex, labLaunch(host))

    await expect(
      adapter.acquire({
        identity: identityFor(SESSION_ID),
        fence: 7,
        spawnToken: 'spawn-lab-login-rejected'
      })
    ).rejects.toThrow('Codex laboratory external ChatGPT login failed')

    expect(codex.connections[0].calls.map(({ method }) => method)).toEqual(['account/login/start'])
    expect(codex.connections[0].closeCount).toBe(1)
    expect(refreshSource).not.toHaveBeenCalled()
    expect(() => host.refresh({ reason: 'unauthorized', previousAccountId: WORKSPACE_ID })).toThrow(
      expect.objectContaining({ reason: 'host_disposed' })
    )
  })

  it.each([
    {
      mismatch: 'session',
      identitySessionId: 'foreign-session',
      launchOverrides: {}
    },
    {
      mismatch: 'dispatch',
      identitySessionId: SESSION_ID,
      launchOverrides: { dynamicDispatchId: 'dispatch-foreign' }
    },
    {
      mismatch: 'workspace',
      identitySessionId: SESSION_ID,
      launchOverrides: {
        attestedWorkspaceId: '00000000-0000-4000-8000-000000000999'
      }
    }
  ])(
    'refuses a $mismatch authority mismatch before spawn and disposes auth',
    async ({ identitySessionId, launchOverrides }) => {
      const { host } = authHost()
      const codex = fakeCodex()
      const adapter = adapterFor(codex, labLaunch(host, launchOverrides))

      await expect(
        adapter.acquire({
          identity: identityFor(identitySessionId),
          fence: 7,
          spawnToken: 'spawn-lab-binding-mismatch'
        })
      ).rejects.toThrow('external ChatGPT auth does not match the session, dispatch, and workspace')

      expect(codex.connections).toEqual([])
      expect(() => host.takeInitialLoginParams()).toThrow(
        expect.objectContaining({ reason: 'host_disposed' })
      )
    }
  )

  it('disposes auth when dynamic-host launch mode is refused before spawn', async () => {
    const { host } = authHost()
    const codex = fakeCodex()
    const launch = labLaunch(host)
    launch.workerAccessMode = 'orca-cli'
    const adapter = adapterFor(codex, launch)

    await expect(
      adapter.acquire({
        identity: identityFor(SESSION_ID),
        fence: 7,
        spawnToken: 'spawn-lab-dynamic-mode-refused'
      })
    ).rejects.toThrow('dynamic tools require lab-gateway worker access')

    expect(codex.connections).toEqual([])
    expect(() => host.refresh({ reason: 'unauthorized', previousAccountId: WORKSPACE_ID })).toThrow(
      expect.objectContaining({ reason: 'host_disposed' })
    )
  })

  it('answers refresh directly while login is pending, before thread open or publication', async () => {
    const initial = jwt('initial-direct')
    const refreshed = jwt('refreshed-direct')
    const { host, refreshSource } = authHost({ initial, refreshed })
    const events: CodexStructuredSessionEvent[] = []
    const codex = fakeCodex()
    const expected = labLaunch(host).labAppServerAttestationExpected!
    codex.routes['thread/start'] = () => testCodexLabOpenedThread(expected, false, 'thread-abc')
    codex.routes['account/read'] = () => testCodexLabAccount(expected)
    codex.routes['config/read'] = () => ({
      config: testCodexLabEffectiveConfig(expected),
      origins: {},
      layers: []
    })
    codex.routes['configRequirements/read'] = () => ({ requirements: null })
    codex.routes['permissionProfile/list'] = () => testCodexLabPermissionProfiles(expected)
    codex.routes['account/login/start'] = async () => {
      const live = codex.connections[0]
      live.handlers.onServerRequest?.({
        id: 41,
        method: CODEX_AUTH_TOKEN_REFRESH_METHOD,
        params: { reason: 'unauthorized', previousAccountId: WORKSPACE_ID }
      })
      await vi.waitFor(() => expect(live.replies).toHaveLength(1))
      expect(live.calls.map(({ method }) => method)).toEqual(['account/login/start'])
      expect(events).toEqual([])
      return { type: 'chatgptAuthTokens' }
    }
    const adapter = adapterFor(codex, labLaunch(host), events)

    await adapter.acquire({
      identity: identityFor(SESSION_ID),
      fence: 7,
      spawnToken: 'spawn-lab-external-auth'
    })

    expect(refreshSource).toHaveBeenCalledOnce()
    expect(codex.connections[0].replies).toEqual([
      {
        id: 41,
        result: {
          accessToken: refreshed,
          chatgptAccountId: WORKSPACE_ID,
          chatgptPlanType: 'business'
        }
      }
    ])
    expect(codex.connections[0].calls.map(({ method }) => method)).toEqual([
      'account/login/start',
      'thread/start',
      'account/read',
      'config/read',
      'configRequirements/read',
      'permissionProfile/list'
    ])
    expect(JSON.stringify(events)).not.toContain(initial)
    expect(JSON.stringify(events)).not.toContain(refreshed)

    codex.connections[0].handlers.onExitObserved?.()
    expect(() => host.refresh({ reason: 'unauthorized', previousAccountId: WORKSPACE_ID })).toThrow(
      expect.objectContaining({ reason: 'host_disposed' })
    )
  })

  it.each([
    ['wrong account', { reason: 'unauthorized', previousAccountId: 'foreign' }],
    ['extra field', { reason: 'unauthorized', previousAccountId: WORKSPACE_ID, persist: true }],
    ['wrong reason', { reason: 'scheduled', previousAccountId: WORKSPACE_ID }],
    ['non-object', 'unauthorized']
  ])(
    'rejects a %s refresh request without calling the credential source',
    async (_case, params) => {
      const { host, refreshSource } = authHost()
      host.takeInitialLoginParams()
      const transport = connection()

      const handled = tryRespondToCodexLabExternalChatGptRefresh(transport.value, host, {
        id: 91,
        method: CODEX_AUTH_TOKEN_REFRESH_METHOD,
        params
      })

      expect(handled).not.toBe(false)
      await handled
      expect(refreshSource).not.toHaveBeenCalled()
      expect(transport.respond).not.toHaveBeenCalled()
      expect(transport.respondWithError).toHaveBeenCalledWith(
        91,
        -32_001,
        'Orca could not refresh app-server auth tokens'
      )
    }
  )

  it('keeps source failures and token material out of refresh errors', async () => {
    const token = jwt('source-error-secret')
    const { host } = authHost({
      initial: token,
      refresh: async () => {
        throw new Error(`do not expose ${token}`)
      }
    })
    host.takeInitialLoginParams()
    const transport = connection()
    const handled = tryRespondToCodexLabExternalChatGptRefresh(transport.value, host, {
      id: 'refresh-secret',
      method: CODEX_AUTH_TOKEN_REFRESH_METHOD,
      params: { reason: 'unauthorized', previousAccountId: WORKSPACE_ID }
    })

    expect(handled).not.toBe(false)
    await handled
    expect(JSON.stringify(transport.respondWithError.mock.calls)).not.toContain(token)
    expect(transport.respondWithError).toHaveBeenCalledWith(
      'refresh-secret',
      -32_001,
      'Orca could not refresh app-server auth tokens'
    )
  })

  it('leaves unrelated server requests untouched', () => {
    const { host } = authHost()
    const transport = connection()

    expect(
      tryRespondToCodexLabExternalChatGptRefresh(transport.value, host, {
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: {}
      })
    ).toBe(false)
    expect(transport.respond).not.toHaveBeenCalled()
    expect(transport.respondWithError).not.toHaveBeenCalled()
  })
})
