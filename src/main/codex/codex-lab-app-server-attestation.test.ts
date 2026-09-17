import { describe, expect, it, vi } from 'vitest'
import {
  DISABLED_CODEX_LAB_FEATURES,
  ENABLED_CODEX_LAB_CONFINEMENT_FEATURES
} from '../runtime/orchestration/lab-profile/codex-lab-launch-policy'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import {
  CODEX_LAB_ATTESTATION_METHODS,
  CODEX_LAB_DYNAMIC_TOOL_GATEWAY_MAP,
  CODEX_LAB_FORBIDDEN_OUT_OF_BAND_METHODS,
  CodexLabAppServerMethodRefusedError,
  createCodexLabAttestationSurface,
  probeCodexLabAppServerReadiness,
  type CodexLabAppServerAttestationInput
} from './codex-lab-app-server-attestation'
import { CODEX_LAB_DYNAMIC_TOOL_SPECS } from './codex-lab-dynamic-tool-contract'

const EXPECTED = Object.freeze({
  cwd: '/private/tmp/orca-lab/worktree',
  codexHome: '/private/tmp/orca-lab/codex-home',
  fakeHome: '/private/tmp/orca-lab/home',
  workspaceId: 'workspace_test',
  permissionProfileId: 'orca-lab-readonly-v1'
})

type Transcript = Readonly<{
  account?: unknown
  config?: unknown
  requirements?: unknown
  permissionPages?: readonly unknown[]
  unavailableMethod?: string
}>

function makeThreadStartParams(): Record<string, unknown> {
  return {
    cwd: EXPECTED.cwd,
    permissions: EXPECTED.permissionProfileId,
    approvalPolicy: 'never',
    ephemeral: true,
    runtimeWorkspaceRoots: [EXPECTED.cwd],
    dynamicTools: structuredClone(CODEX_LAB_DYNAMIC_TOOL_SPECS)
  }
}

function makeOpenedThread(): Record<string, unknown> {
  return {
    cwd: EXPECTED.cwd,
    runtimeWorkspaceRoots: [EXPECTED.cwd],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    modelProvider: 'openai',
    disabledPluginIds: [],
    multiAgentMode: 'explicitRequestOnly',
    activePermissionProfile: { id: EXPECTED.permissionProfileId, extends: ':read-only' },
    sandbox: { type: 'readOnly', networkAccess: false },
    thread: { id: 'thread_test', ephemeral: true },
    instructionSources: [`${EXPECTED.cwd}/AGENTS.md`]
  }
}

function makeAccount(): Record<string, unknown> {
  return {
    account: { type: 'chatgpt', email: null, planType: 'business' },
    requiresOpenaiAuth: true,
    workspaceRouting: {
      chatgptAccountId: EXPECTED.workspaceId,
      backendOrigin: 'https://chatgpt.com',
      accountRoutingOverride: 'NO_CONSTRAINT'
    }
  }
}

function makeConfig(): Record<string, unknown> {
  const disabledFeatures = Object.fromEntries(
    DISABLED_CODEX_LAB_FEATURES.map((feature) => [feature, false])
  )
  const enabledFeatures = Object.fromEntries(
    ENABLED_CODEX_LAB_CONFINEMENT_FEATURES.map((feature) => [feature, true])
  )
  return {
    approval_policy: 'never',
    default_permissions: EXPECTED.permissionProfileId,
    forced_login_method: 'chatgpt',
    forced_chatgpt_workspace_id: EXPECTED.workspaceId,
    web_search: 'disabled',
    cli_auth_credentials_store: 'keyring',
    check_for_update_on_startup: false,
    file_opener: 'none',
    allow_login_shell: false,
    analytics: { enabled: false },
    history: { persistence: 'none', max_bytes: null },
    tools: {
      web_search: null,
      experimental_request_user_input: null,
      update_plan: null
    },
    mcp_servers: {},
    hooks: {
      PreToolUse: [],
      PermissionRequest: [],
      PostToolUse: [],
      PreCompact: [],
      PostCompact: [],
      SessionStart: [],
      SessionEnd: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
      Stop: [],
      Interrupt: []
    },
    shell_environment_policy: {
      inherit: 'none',
      include_only: [],
      ignore_default_excludes: false,
      experimental_use_profile: false,
      exclude: null,
      filters: null,
      set: {
        CODEX_HOME: EXPECTED.codexHome,
        HOME: EXPECTED.fakeHome,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
      }
    },
    features: { network_proxy: false, ...disabledFeatures, ...enabledFeatures },
    skills: { include_instructions: false, bundled: { enabled: false } },
    permissions: {
      [EXPECTED.permissionProfileId]: {
        description: 'Disposable read-only laboratory worker',
        extends: ':read-only',
        workspace_roots: { [EXPECTED.cwd]: true },
        filesystem: {
          glob_scan_max_depth: null,
          ':root': 'deny',
          ':minimal': 'read',
          ':tmpdir': 'deny',
          ':slash_tmp': 'deny',
          ':workspace_roots': { '.': 'read' }
        },
        network: {
          enabled: false,
          proxy_url: null,
          enable_socks5: null,
          socks_url: null,
          enable_socks5_udp: null,
          allow_local_binding: false,
          allow_upstream_proxy: false,
          dangerously_allow_non_loopback_proxy: null,
          dangerously_allow_all_unix_sockets: false,
          mode: null,
          domains: null,
          mitm: null,
          unix_sockets: {}
        }
      }
    }
  }
}

function makePermissionPages(): readonly unknown[] {
  return [
    {
      data: [{ id: 'built-in', description: null, allowed: true }],
      nextCursor: 'page_2'
    },
    {
      data: [
        {
          id: EXPECTED.permissionProfileId,
          description: 'Disposable read-only laboratory worker',
          allowed: true
        }
      ],
      nextCursor: null
    }
  ]
}

function fakeInput(transcript: Transcript = {}): {
  input: CodexLabAppServerAttestationInput
  request: ReturnType<typeof vi.fn<CodexAppServerConnection['request']>>
} {
  let permissionPage = 0
  const request = vi.fn<CodexAppServerConnection['request']>(async (method) => {
    if (method === transcript.unavailableMethod) {
      throw new Error('method unavailable')
    }
    if (method === 'account/read') {
      return transcript.account ?? makeAccount()
    }
    if (method === 'config/read') {
      return transcript.config ?? { config: makeConfig(), origins: {}, layers: [] }
    }
    if (method === 'configRequirements/read') {
      return transcript.requirements ?? { requirements: null }
    }
    if (method === 'permissionProfile/list') {
      const pages = transcript.permissionPages ?? makePermissionPages()
      const page = pages[permissionPage]
      permissionPage += 1
      return page
    }
    throw new Error(`unexpected method: ${method}`)
  })
  return {
    input: {
      connection: { request },
      expected: EXPECTED,
      threadStartParams: makeThreadStartParams(),
      openedThread: makeOpenedThread(),
      timeoutMs: 2_000
    },
    request
  }
}

describe('TASK-757 Codex app-server policy attestation', () => {
  it('requires all four official reads before returning secret-free readiness evidence', async () => {
    const { input, request } = fakeInput()

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: true,
      evidence: {
        methods: CODEX_LAB_ATTESTATION_METHODS,
        permissionProfileId: EXPECTED.permissionProfileId,
        permissionProfilePages: 2,
        managedRequirements: 'absent',
        accountRoute: 'chatgpt-workspace',
        dynamicToolGatewayMap: CODEX_LAB_DYNAMIC_TOOL_GATEWAY_MAP,
        outOfBandMethods: 'not-requested-by-attestation-probe'
      }
    })
    expect(request).toHaveBeenNthCalledWith(1, 'account/read', {}, { timeoutMs: 2_000 })
    expect(request).toHaveBeenNthCalledWith(
      2,
      'config/read',
      { includeLayers: true, cwd: EXPECTED.cwd },
      { timeoutMs: 2_000 }
    )
    expect(request).toHaveBeenNthCalledWith(3, 'configRequirements/read', undefined, {
      timeoutMs: 2_000
    })
    expect(request).toHaveBeenNthCalledWith(
      4,
      'permissionProfile/list',
      { cwd: EXPECTED.cwd },
      { timeoutMs: 2_000 }
    )
    expect(request).toHaveBeenNthCalledWith(
      5,
      'permissionProfile/list',
      { cwd: EXPECTED.cwd, cursor: 'page_2' },
      { timeoutMs: 2_000 }
    )
  })

  it('does not expose shellCommand or any process method on the attestation surface', async () => {
    const upstream = vi.fn<CodexAppServerConnection['request']>()
    const surface = createCodexLabAttestationSurface({ request: upstream })

    expect(CODEX_LAB_FORBIDDEN_OUT_OF_BAND_METHODS).toEqual(['thread/shellCommand', 'process/*'])
    for (const method of ['thread/shellCommand', 'process/spawn', 'process/write']) {
      await expect(surface.request(method, {})).rejects.toMatchObject({
        name: CodexLabAppServerMethodRefusedError.name,
        method
      })
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it.each(CODEX_LAB_ATTESTATION_METHODS)(
    'stays unready when required RPC %s is unavailable',
    async (unavailableMethod) => {
      const { input } = fakeInput({ unavailableMethod })

      await expect(probeCodexLabAppServerReadiness(input)).resolves.toMatchObject({
        ready: false,
        reason: 'rpc_unavailable'
      })
    }
  )

  it('rejects missing, extra, or reordered dynamic tools before reading policy', async () => {
    const { input, request } = fakeInput()
    const params = makeThreadStartParams()
    const tools = structuredClone(CODEX_LAB_DYNAMIC_TOOL_SPECS)
    params.dynamicTools = tools.toReversed()

    await expect(
      probeCodexLabAppServerReadiness({ ...input, threadStartParams: params })
    ).resolves.toEqual({
      ready: false,
      reason: 'thread_request_unverified',
      field: 'threadStartParams.dynamicTools'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects broadened effective config without exposing transcript contents', async () => {
    const config = makeConfig()
    const profile = getProfile(config)
    const network = requireRecord(profile.network, 'network')
    network.enabled = true
    network.unix_sockets = { '/private/tmp/orca-gateway.sock': 'read-write' }
    const { input } = fakeInput({ config: { config, origins: {}, layers: [] } })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: `config.permissions.${EXPECTED.permissionProfileId}.network`
    })
  })

  it('rejects enabled or missing analytics', async () => {
    const enabled = makeConfig()
    enabled.analytics = { enabled: true }
    const enabledCase = fakeInput({ config: { config: enabled, origins: {}, layers: [] } })
    await expect(probeCodexLabAppServerReadiness(enabledCase.input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.analytics'
    })

    const missing = makeConfig()
    delete missing.analytics
    const missingCase = fakeInput({ config: { config: missing, origins: {}, layers: [] } })
    await expect(probeCodexLabAppServerReadiness(missingCase.input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.analytics'
    })
  })

  it('rejects child gateway environment access', async () => {
    const withCredential = makeConfig()
    const shell = requireRecord(withCredential.shell_environment_policy, 'shell_environment_policy')
    shell.include_only = ['ORCA_LAB_GATEWAY_CREDENTIAL']
    const credentialCase = fakeInput({
      config: { config: withCredential, origins: {}, layers: [] }
    })
    await expect(probeCodexLabAppServerReadiness(credentialCase.input)).resolves.toMatchObject({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.shell_environment_policy'
    })
  })

  it('tolerates unrelated model defaults but rejects unknown policy-subtree keys', async () => {
    const withModelDefaults = makeConfig()
    withModelDefaults.model = 'gpt-current'
    withModelDefaults.model_context_window = 200_000
    withModelDefaults.project_doc_max_bytes = 32_768
    const defaultsCase = fakeInput({
      config: { config: withModelDefaults, origins: {}, layers: [] }
    })
    await expect(probeCodexLabAppServerReadiness(defaultsCase.input)).resolves.toMatchObject({
      ready: true
    })

    const withUnknownPolicy = makeConfig()
    const features = requireRecord(withUnknownPolicy.features, 'features')
    features.future_unattested_power = true
    const unknownCase = fakeInput({
      config: { config: withUnknownPolicy, origins: {}, layers: [] }
    })
    await expect(probeCodexLabAppServerReadiness(unknownCase.input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.features.future_unattested_power'
    })
  })

  it.each([
    [{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }, 'account/read.account.type'],
    [
      { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true },
      'account/read.account.planType'
    ],
    [{ ...makeAccount(), requiresOpenaiAuth: false }, 'account/read.requiresOpenaiAuth'],
    [
      {
        account: { type: 'chatgpt', email: null, planType: 'business' },
        requiresOpenaiAuth: true
      },
      'account/read.workspaceRouting'
    ],
    [
      {
        ...makeAccount(),
        workspaceRouting: {
          chatgptAccountId: 'another_workspace',
          backendOrigin: 'https://chatgpt.com',
          accountRoutingOverride: 'NO_CONSTRAINT'
        }
      },
      'account/read.workspaceRouting'
    ]
  ])('rejects non-workspace or unresolved account routing %#', async (account, field) => {
    const { input } = fakeInput({ account })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'account_unverified',
      field
    })
  })

  it.each([
    [{ futureRequirement: true }, 'requirements.futureRequirement'],
    [{ allowBrowserAndComputerUse: true }, 'requirements.allowBrowserAndComputerUse'],
    [{ allowedApprovalPolicies: ['never', 'on-request'] }, 'requirements.allowedApprovalPolicies'],
    [{ network: { enabled: false } }, 'requirements.network']
  ])('rejects unknown or unverified managed requirements %#', async (requirements, field) => {
    const { input } = fakeInput({ requirements: { requirements } })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'requirements_broadened',
      field
    })
  })

  it('requires the selected permission profile to be uniquely present and allowed', async () => {
    const denied = fakeInput({
      permissionPages: [
        {
          data: [
            {
              id: EXPECTED.permissionProfileId,
              description: 'denied by managed policy',
              allowed: false
            }
          ],
          nextCursor: null
        }
      ]
    })
    await expect(probeCodexLabAppServerReadiness(denied.input)).resolves.toEqual({
      ready: false,
      reason: 'permission_profile_denied',
      field: 'permissionProfile/list.data.allowed'
    })

    const absent = fakeInput({
      permissionPages: [{ data: [], nextCursor: null }]
    })
    await expect(probeCodexLabAppServerReadiness(absent.input)).resolves.toEqual({
      ready: false,
      reason: 'permission_profile_unavailable',
      field: 'permissionProfile/list.data'
    })
  })
})

function getProfile(config: Record<string, unknown>): Record<string, unknown> {
  const permissions = requireRecord(config.permissions, 'permissions')
  return requireRecord(permissions[EXPECTED.permissionProfileId], 'permission profile')
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`test fixture ${name} is missing`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
