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
import {
  codexLabCapacityPolicy,
  mintCodexLabUsageAuthorization
} from '../runtime/orchestration/lab-profile/codex-lab-usage-authorization'

const EXPECTED = Object.freeze({
  cwd: '/private/tmp/orca-lab/worktree',
  codexHome: '/private/tmp/orca-lab/codex-home',
  fakeHome: '/private/tmp/orca-lab/home',
  gatewaySocketPath: '/private/tmp/orca-lab/runtime/dispatches/test/gateway.sock',
  workspaceId: 'workspace_test',
  permissionProfileId: 'orca-lab-readonly-v1',
  capacityPolicy: codexLabCapacityPolicy({
    workspaceId: 'workspace_test',
    planType: 'business',
    authorization: null
  })
})

const METERED_AUTHORIZATION = mintCodexLabUsageAuthorization({
  workspaceId: EXPECTED.workspaceId,
  planType: 'enterprise_cbp_usage_based',
  expiresAt: '2099-09-24T23:00:00.000Z',
  nowMs: 0
})
const METERED_EXPECTED = Object.freeze({
  ...EXPECTED,
  capacityPolicy: codexLabCapacityPolicy({
    workspaceId: EXPECTED.workspaceId,
    planType: 'enterprise_cbp_usage_based',
    authorization: METERED_AUTHORIZATION,
    nowMs: 0
  })
})

type Transcript = Readonly<{
  account?: unknown
  rateLimits?: unknown
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
    multiAgentMode: 'explicitRequestOnly',
    activePermissionProfile: { id: EXPECTED.permissionProfileId, extends: ':read-only' },
    sandbox: { type: 'readOnly', networkAccess: true },
    thread: { id: 'thread_test', ephemeral: true },
    instructionSources: [`${EXPECTED.cwd}/AGENTS.md`]
  }
}

function makeAccount(): Record<string, unknown> {
  return {
    account: { type: 'chatgpt', email: null, planType: 'business' },
    requiresOpenaiAuth: true
  }
}

function makeRateLimits(): Record<string, unknown> {
  return {
    accountId: EXPECTED.workspaceId,
    ordinaryUsageAllowed: true,
    rateLimits: { planType: 'business' }
  }
}

function makeMeteredRateLimits(
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  const rateLimits = {
    credits: { hasCredits: true, unlimited: false, balance: null },
    individualLimit: {
      limit: '1000.00',
      used: '350.00',
      remainingPercent: 65.5,
      resetsAt: 4_102_444_800
    },
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    planType: 'enterprise_cbp_usage_based',
    primary: null,
    rateLimitReachedType: null,
    secondary: null,
    spendControlReached: false,
    ...(typeof overrides.rateLimits === 'object' && overrides.rateLimits !== null
      ? overrides.rateLimits
      : {})
  }
  return {
    accountId: EXPECTED.workspaceId,
    ordinaryUsageAllowed: null,
    rateLimitResetCredits: null,
    rateLimitUpsell: null,
    rateLimitsByLimitId: null,
    ...overrides,
    rateLimits
  }
}

function makeExternalAuthReceipt(
  overrides: Partial<
    Pick<
      CodexLabAppServerAttestationInput['externalAuthReceipt'],
      'chatgptAccountId' | 'chatgptPlanType'
    >
  > = {},
  frozen = true
): CodexLabAppServerAttestationInput['externalAuthReceipt'] {
  const receipt: CodexLabAppServerAttestationInput['externalAuthReceipt'] = {
    type: 'chatgptAuthTokens',
    chatgptAccountId: EXPECTED.workspaceId,
    chatgptPlanType: 'business',
    ...overrides
  }
  return frozen ? Object.freeze(receipt) : receipt
}

function alteredExternalAuthReceipt(
  field: string,
  value: unknown
): CodexLabAppServerAttestationInput['externalAuthReceipt'] {
  const receipt = makeExternalAuthReceipt({}, false)
  Reflect.set(receipt, field, value)
  return Object.freeze(receipt)
}

function externalAuthReceiptWithout(
  field: string
): CodexLabAppServerAttestationInput['externalAuthReceipt'] {
  const receipt = makeExternalAuthReceipt({}, false)
  Reflect.deleteProperty(receipt, field)
  return Object.freeze(receipt)
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
    cli_auth_credentials_store: 'ephemeral',
    check_for_update_on_startup: false,
    file_opener: 'none',
    allow_login_shell: false,
    analytics: { enabled: false },
    feedback: { enabled: false },
    otel: {
      tool_result: {},
      log_user_prompt: false,
      environment: null,
      exporter: 'none',
      trace_exporter: 'none',
      metrics_exporter: 'none',
      span_attributes: null,
      tracestate: null
    },
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
    features: { network_proxy: true, ...disabledFeatures, ...enabledFeatures },
    skills: { include_instructions: false, bundled: { enabled: false } },
    permissions: {
      [EXPECTED.permissionProfileId]: {
        description: 'Disposable read-only laboratory worker',
        extends: ':read-only',
        network: {
          enabled: true,
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
          unix_sockets: { [EXPECTED.gatewaySocketPath]: 'allow' }
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
    if (method === 'account/rateLimits/read') {
      return transcript.rateLimits ?? makeRateLimits()
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
      externalAuthReceipt: makeExternalAuthReceipt(),
      threadStartParams: makeThreadStartParams(),
      openedThread: makeOpenedThread(),
      timeoutMs: 2_000
    },
    request
  }
}

describe('TASK-757 Codex app-server policy attestation', () => {
  it('requires all five official reads before returning secret-free readiness evidence', async () => {
    const { input, request } = fakeInput()

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: true,
      evidence: {
        methods: CODEX_LAB_ATTESTATION_METHODS,
        permissionProfileId: EXPECTED.permissionProfileId,
        permissionProfilePages: 2,
        managedRequirements: 'absent',
        accountRoute: 'chatgpt-workspace',
        capacityRoute: 'ordinary-included',
        dynamicToolGatewayMap: CODEX_LAB_DYNAMIC_TOOL_GATEWAY_MAP,
        outOfBandMethods: 'not-requested-by-attestation-probe'
      }
    })
    expect(request).toHaveBeenNthCalledWith(1, 'account/read', {}, { timeoutMs: 2_000 })
    expect(request).toHaveBeenNthCalledWith(2, 'account/rateLimits/read', undefined, {
      timeoutMs: 2_000
    })
    expect(request).toHaveBeenNthCalledWith(
      3,
      'config/read',
      { includeLayers: true, cwd: EXPECTED.cwd },
      { timeoutMs: 2_000 }
    )
    expect(request).toHaveBeenNthCalledWith(4, 'configRequirements/read', undefined, {
      timeoutMs: 2_000
    })
    expect(request).toHaveBeenNthCalledWith(
      5,
      'permissionProfile/list',
      { cwd: EXPECTED.cwd },
      { timeoutMs: 2_000 }
    )
    expect(request).toHaveBeenNthCalledWith(
      6,
      'permissionProfile/list',
      { cwd: EXPECTED.cwd, cursor: 'page_2' },
      { timeoutMs: 2_000 }
    )
  })

  it('accepts the pinned Codex 0.155 opened-thread response without newer plugin metadata', async () => {
    const { input } = fakeInput()
    const openedThread = makeOpenedThread()
    expect(Object.hasOwn(openedThread, 'disabledPluginIds')).toBe(false)

    await expect(
      probeCodexLabAppServerReadiness({ ...input, openedThread })
    ).resolves.toMatchObject({ ready: true })
  })

  it.each([undefined, null, [], 'plugin@example', ['plugin@example']])(
    'rejects disabled-plugin metadata outside the pinned response schema %#',
    async (disabledPluginIds) => {
      const { input, request } = fakeInput()
      const openedThread = { ...makeOpenedThread(), disabledPluginIds }

      await expect(probeCodexLabAppServerReadiness({ ...input, openedThread })).resolves.toEqual({
        ready: false,
        reason: 'thread_result_unverified',
        field: 'openedThread.disabledPluginIds'
      })
      expect(request).not.toHaveBeenCalled()
    }
  )

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
    network.domains = { '*': 'allow' }
    const { input } = fakeInput({ config: { config, origins: {}, layers: [] } })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: `config.permissions.${EXPECTED.permissionProfileId}.network`
    })
  })

  it('accepts only the official ChatGPT backend as an explicit ChatGPT base URL', async () => {
    const officialConfig = makeConfig()
    officialConfig.chatgpt_base_url = 'https://chatgpt.com/backend-api/'
    const official = fakeInput({
      config: { config: officialConfig, origins: {}, layers: [] }
    })

    await expect(probeCodexLabAppServerReadiness(official.input)).resolves.toMatchObject({
      ready: true
    })

    const proxyConfig = makeConfig()
    proxyConfig.chatgpt_base_url = 'https://llm-proxy.example/backend-api/'
    const proxy = fakeInput({ config: { config: proxyConfig, origins: {}, layers: [] } })

    await expect(probeCodexLabAppServerReadiness(proxy.input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.chatgpt_base_url'
    })
  })

  it.each([
    ['filesystem', { writable_roots: [EXPECTED.cwd] }],
    ['workspace_roots', [EXPECTED.cwd]]
  ])('rejects a permission-profile %s override', async (field, value) => {
    const config = makeConfig()
    Reflect.set(getProfile(config), field, value)
    const { input } = fakeInput({ config: { config, origins: {}, layers: [] } })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: `config.permissions.${EXPECTED.permissionProfileId}`
    })
  })

  it('requires proxy enforcement, network enablement, and only the exact gateway socket', async () => {
    const cases = [
      {
        expectedField: 'config.features',
        mutate(config: Record<string, unknown>) {
          requireRecord(config.features, 'features').network_proxy = false
        }
      },
      {
        expectedField: `config.permissions.${EXPECTED.permissionProfileId}.network`,
        mutate(config: Record<string, unknown>) {
          const profile = getProfile(config)
          requireRecord(profile.network, 'network').enabled = false
        }
      },
      {
        expectedField: `config.permissions.${EXPECTED.permissionProfileId}.network`,
        mutate(config: Record<string, unknown>) {
          const profile = getProfile(config)
          requireRecord(profile.network, 'network').unix_sockets = {
            [EXPECTED.gatewaySocketPath]: 'allow',
            '/private/tmp/alternate.sock': 'allow'
          }
        }
      }
    ]

    for (const testCase of cases) {
      const config = makeConfig()
      testCase.mutate(config)
      const { input } = fakeInput({ config: { config, origins: {}, layers: [] } })

      await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
        ready: false,
        reason: 'effective_config_broadened',
        field: testCase.expectedField
      })
    }
  })

  it('accepts an explicit empty domain policy', async () => {
    const config = makeConfig()
    const profile = getProfile(config)
    requireRecord(profile.network, 'network').domains = {}
    const { input } = fakeInput({ config: { config, origins: {}, layers: [] } })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toMatchObject({ ready: true })
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

  it('rejects enabled or missing feedback', async () => {
    const enabled = makeConfig()
    enabled.feedback = { enabled: true }
    const enabledCase = fakeInput({ config: { config: enabled, origins: {}, layers: [] } })
    await expect(probeCodexLabAppServerReadiness(enabledCase.input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.feedback'
    })

    const missing = makeConfig()
    delete missing.feedback
    const missingCase = fakeInput({ config: { config: missing, origins: {}, layers: [] } })
    await expect(probeCodexLabAppServerReadiness(missingCase.input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.feedback'
    })
  })

  it.each([
    { label: 'prompt logging', override: { log_user_prompt: true } },
    { label: 'log export', override: { exporter: 'statsig' } },
    { label: 'trace export', override: { trace_exporter: 'statsig' } },
    { label: 'metrics export', override: { metrics_exporter: 'statsig' } },
    { label: 'telemetry environment', override: { environment: 'production' } },
    { label: 'span attributes', override: { span_attributes: { source: 'lab' } } },
    { label: 'trace state', override: { tracestate: { vendor: { key: 'value' } } } }
  ])('rejects broadened $label', async ({ override }) => {
    const broadened = makeConfig()
    const otel = broadened.otel
    if (!otel || typeof otel !== 'object' || Array.isArray(otel)) {
      throw new Error('test fixture is missing its OTEL configuration')
    }
    broadened.otel = { ...otel, ...override }
    const { input } = fakeInput({
      config: { config: broadened, origins: {}, layers: [] }
    })
    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.otel'
    })
  })

  it('rejects missing telemetry confinement', async () => {
    const missing = makeConfig()
    delete missing.otel
    const { input } = fakeInput({ config: { config: missing, origins: {}, layers: [] } })
    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.otel'
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

  it.each([
    ['code_mode', true],
    ['code_mode_host', false]
  ])('rejects incompatible effective %s feature state', async (feature, value) => {
    const config = makeConfig()
    requireRecord(config.features, 'features')[feature] = value
    const { input } = fakeInput({ config: { config, origins: {}, layers: [] } })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: `config.features.${feature}`
    })
  })

  it('tolerates inert defaults but rejects enabled unknown policy features', async () => {
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

    const withDisabledFutureFeature = makeConfig()
    const disabledFeatures = requireRecord(withDisabledFutureFeature.features, 'features')
    disabledFeatures.future_unattested_power = false
    const disabledCase = fakeInput({
      config: { config: withDisabledFutureFeature, origins: {}, layers: [] }
    })
    await expect(probeCodexLabAppServerReadiness(disabledCase.input)).resolves.toMatchObject({
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

  it('rejects encrypted Secrets auth storage so process-local external auth stays authoritative', async () => {
    const withEncryptedAuthStorage = makeConfig()
    const features = requireRecord(withEncryptedAuthStorage.features, 'features')
    features.secret_auth_storage = true
    const encryptedAuthCase = fakeInput({
      config: { config: withEncryptedAuthStorage, origins: {}, layers: [] }
    })

    await expect(probeCodexLabAppServerReadiness(encryptedAuthCase.input)).resolves.toEqual({
      ready: false,
      reason: 'effective_config_broadened',
      field: 'config.features.secret_auth_storage'
    })
  })

  it.each(['keyring', 'file', 'auto'])(
    'rejects non-ephemeral effective credential store %s',
    async (credentialStore) => {
      const config = makeConfig()
      config.cli_auth_credentials_store = credentialStore
      const { input } = fakeInput({ config: { config, origins: {}, layers: [] } })

      await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
        ready: false,
        reason: 'effective_config_broadened',
        field: 'config.cli_auth_credentials_store'
      })
    }
  )

  it('accepts an exact ephemeral managed credential-store constraint', async () => {
    const { input } = fakeInput({
      requirements: { requirements: { cliAuthCredentialsStore: 'ephemeral' } }
    })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toMatchObject({
      ready: true,
      evidence: { managedRequirements: 'compatible' }
    })
  })

  it.each(['keyring', 'file', 'auto'])(
    'rejects managed credential store %s',
    async (credentialStore) => {
      const { input } = fakeInput({
        requirements: { requirements: { cliAuthCredentialsStore: credentialStore } }
      })

      await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
        ready: false,
        reason: 'requirements_broadened',
        field: 'requirements.cliAuthCredentialsStore'
      })
    }
  )

  it('accepts the exact pinned Codex 0.155 account/read response schema', async () => {
    const { input } = fakeInput({
      account: {
        account: { type: 'chatgpt', email: null, planType: 'business' },
        requiresOpenaiAuth: true
      }
    })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toMatchObject({ ready: true })
  })

  it.each([
    [{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }, 'account/read.account.type'],
    [
      { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true },
      'account/read.account.planType'
    ],
    [
      {
        account: { type: 'chatgpt', email: null, planType: 'enterprise' },
        requiresOpenaiAuth: true
      },
      'account/read.account.planType'
    ],
    [{ ...makeAccount(), requiresOpenaiAuth: false }, 'account/read.requiresOpenaiAuth'],
    [
      {
        ...makeAccount(),
        workspaceRouting: {
          chatgptAccountId: EXPECTED.workspaceId,
          backendOrigin: 'https://chatgpt.com',
          accountRoutingOverride: 'NO_CONSTRAINT'
        }
      },
      'account/read'
    ]
  ])('rejects invalid or out-of-schema account evidence %#', async (account, field) => {
    const { input } = fakeInput({ account })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'account_unverified',
      field
    })
  })

  it.each([
    [
      { ordinaryUsageAllowed: true, rateLimits: { planType: 'business' } },
      'account/rateLimits/read.accountId'
    ],
    [{ ...makeRateLimits(), accountId: null }, 'account/rateLimits/read.accountId'],
    [{ ...makeRateLimits(), accountId: 'another_workspace' }, 'account/rateLimits/read.accountId'],
    [{ ...makeRateLimits(), rateLimits: {} }, 'account/rateLimits/read.rateLimits.planType'],
    [
      { ...makeRateLimits(), rateLimits: { planType: null } },
      'account/rateLimits/read.rateLimits.planType'
    ],
    [
      { ...makeRateLimits(), rateLimits: { planType: 'unknown' } },
      'account/rateLimits/read.rateLimits.planType'
    ],
    [{ ...makeRateLimits(), rateLimits: null }, 'account/rateLimits/read.rateLimits'],
    [
      { ...makeRateLimits(), rateLimits: { planType: 'plus' } },
      'account/rateLimits/read.rateLimits.planType'
    ],
    [
      { ...makeRateLimits(), rateLimits: { planType: 'enterprise' } },
      'account/rateLimits/read.rateLimits.planType'
    ],
    [{ ...makeRateLimits(), futureAuthority: true }, 'account/rateLimits/read'],
    [
      { ...makeRateLimits(), rateLimits: { planType: 'business', futureAuthority: true } },
      'account/rateLimits/read.rateLimits'
    ]
  ])('rejects unresolved or broadened backend usage evidence %#', async (rateLimits, field) => {
    const { input } = fakeInput({ rateLimits })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason: 'account_unverified',
      field
    })
  })

  it.each([
    [{ accountId: EXPECTED.workspaceId, rateLimits: { planType: 'business' } }, 'response_invalid'],
    [{ ...makeRateLimits(), ordinaryUsageAllowed: 'allowed' }, 'response_invalid'],
    [{ ...makeRateLimits(), ordinaryUsageAllowed: null }, 'ordinary_usage_unavailable'],
    [{ ...makeRateLimits(), ordinaryUsageAllowed: false }, 'ordinary_usage_blocked']
  ])('classifies non-usage-based capacity evidence %#', async (rateLimits, reason) => {
    const { input } = fakeInput({ rateLimits })

    await expect(probeCodexLabAppServerReadiness(input)).resolves.toEqual({
      ready: false,
      reason,
      field: 'account/rateLimits/read.ordinaryUsageAllowed'
    })
  })

  it.each(['self_serve_business_usage_based', 'enterprise_cbp_usage_based'])(
    'refuses the metered workspace plan %s even when its live budget is available',
    async (planType) => {
      const { input } = fakeInput({
        account: {
          account: { type: 'chatgpt', email: null, planType },
          requiresOpenaiAuth: true
        },
        rateLimits: {
          accountId: EXPECTED.workspaceId,
          ordinaryUsageAllowed: null,
          rateLimits: {
            credits: { hasCredits: true, unlimited: false, balance: null },
            individualLimit: {
              limit: '1000',
              used: '350',
              remainingPercent: 65,
              resetsAt: 1_789_819_200
            },
            limitId: 'codex',
            limitName: null,
            normalModelSlug: null,
            planType,
            primary: null,
            rateLimitReachedType: null,
            secondary: null,
            spendControlReached: false
          }
        }
      })

      await expect(
        probeCodexLabAppServerReadiness({
          ...input,
          externalAuthReceipt: makeExternalAuthReceipt({ chatgptPlanType: planType })
        })
      ).resolves.toEqual({
        ready: false,
        reason: 'paid_usage_forbidden',
        field: 'account/rateLimits/read.rateLimits.planType'
      })
    }
  )

  it('admits only the explicitly authorized exact metered workspace with live capacity', async () => {
    const { input } = fakeInput({
      account: {
        account: {
          type: 'chatgpt',
          email: null,
          planType: 'enterprise_cbp_usage_based'
        },
        requiresOpenaiAuth: true
      },
      rateLimits: makeMeteredRateLimits()
    })

    await expect(
      probeCodexLabAppServerReadiness({
        ...input,
        expected: METERED_EXPECTED,
        externalAuthReceipt: makeExternalAuthReceipt({
          chatgptPlanType: 'enterprise_cbp_usage_based'
        })
      })
    ).resolves.toMatchObject({
      ready: true,
      evidence: { capacityRoute: 'authorized-metered-workspace' }
    })
  })

  it('accepts earned reset-credit metadata without treating it as a separate billing route', async () => {
    const { input } = fakeInput({
      account: {
        account: {
          type: 'chatgpt',
          email: null,
          planType: 'enterprise_cbp_usage_based'
        },
        requiresOpenaiAuth: true
      },
      rateLimits: makeMeteredRateLimits({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: 'reset-credit-1',
              resetType: 'codexRateLimits',
              status: 'available',
              grantedAt: 4_102_358_400,
              expiresAt: 4_102_444_800,
              title: null,
              description: null
            }
          ]
        }
      })
    })

    await expect(
      probeCodexLabAppServerReadiness({
        ...input,
        expected: METERED_EXPECTED,
        externalAuthReceipt: makeExternalAuthReceipt({
          chatgptPlanType: 'enterprise_cbp_usage_based'
        })
      })
    ).resolves.toMatchObject({
      ready: true,
      evidence: { capacityRoute: 'authorized-metered-workspace' }
    })
  })

  it('rechecks the metered authorization expiry during live app-server attestation', async () => {
    const { input } = fakeInput({
      account: {
        account: {
          type: 'chatgpt',
          email: null,
          planType: 'enterprise_cbp_usage_based'
        },
        requiresOpenaiAuth: true
      },
      rateLimits: makeMeteredRateLimits()
    })
    const expiredExpected = Object.freeze({
      ...METERED_EXPECTED,
      capacityPolicy: Object.freeze({
        ...METERED_EXPECTED.capacityPolicy,
        expiresAt: '2000-01-01T00:00:00.000Z'
      })
    })

    await expect(
      probeCodexLabAppServerReadiness({
        ...input,
        expected: expiredExpected,
        externalAuthReceipt: makeExternalAuthReceipt({
          chatgptPlanType: 'enterprise_cbp_usage_based'
        })
      })
    ).resolves.toEqual({
      ready: false,
      reason: 'metered_usage_authorization_expired',
      field: 'expected.capacityPolicy.expiresAt'
    })
  })

  it.each([
    [
      'spent credits',
      makeMeteredRateLimits({
        rateLimits: { credits: { hasCredits: false, unlimited: false, balance: null } }
      }),
      'ordinary_usage_blocked',
      'account/rateLimits/read.rateLimits.credits.hasCredits'
    ],
    [
      'malformed keyed codex bucket',
      makeMeteredRateLimits({ rateLimitsByLimitId: { codex: {} } }),
      'response_invalid',
      'account/rateLimits/read.rateLimitsByLimitId.codex.limitId'
    ],
    [
      'exhausted individual limit',
      makeMeteredRateLimits({
        rateLimits: {
          individualLimit: {
            limit: '1000',
            used: '1000',
            remainingPercent: 0,
            resetsAt: 4_102_444_800
          }
        }
      }),
      'ordinary_usage_blocked',
      'account/rateLimits/read.rateLimits.individualLimit'
    ],
    [
      'spend control reached',
      makeMeteredRateLimits({ rateLimits: { spendControlReached: true } }),
      'ordinary_usage_blocked',
      'account/rateLimits/read.rateLimits.spendControlReached'
    ],
    [
      'provider reports a reached limit',
      makeMeteredRateLimits({ rateLimits: { rateLimitReachedType: 'hard_limit' } }),
      'ordinary_usage_blocked',
      'account/rateLimits/read.rateLimits.rateLimitReachedType'
    ],
    [
      'unknown future field',
      makeMeteredRateLimits({ rateLimits: { futureCapacity: true } }),
      'account_unverified',
      'account/rateLimits/read.rateLimits'
    ]
  ])('refuses authorized metered evidence with %s', async (_label, rateLimits, reason, field) => {
    const { input } = fakeInput({
      account: {
        account: {
          type: 'chatgpt',
          email: null,
          planType: 'enterprise_cbp_usage_based'
        },
        requiresOpenaiAuth: true
      },
      rateLimits
    })

    await expect(
      probeCodexLabAppServerReadiness({
        ...input,
        expected: METERED_EXPECTED,
        externalAuthReceipt: makeExternalAuthReceipt({
          chatgptPlanType: 'enterprise_cbp_usage_based'
        })
      })
    ).resolves.toEqual({ ready: false, reason, field })
  })

  it.each([
    [
      makeExternalAuthReceipt({
        chatgptAccountId: 'another_workspace'
      }),
      'externalAuthReceipt'
    ],
    [
      makeExternalAuthReceipt({
        chatgptPlanType: 'plus'
      }),
      'externalAuthReceipt'
    ],
    [makeExternalAuthReceipt({}, false), 'externalAuthReceipt'],
    [alteredExternalAuthReceipt('type', 'apiKey'), 'externalAuthReceipt'],
    [alteredExternalAuthReceipt('futureAuthority', true), 'externalAuthReceipt'],
    [externalAuthReceiptWithout('chatgptPlanType'), 'externalAuthReceipt']
  ])('rejects unbound external-auth receipt evidence %#', async (externalAuthReceipt, field) => {
    const { input } = fakeInput()

    await expect(
      probeCodexLabAppServerReadiness({
        ...input,
        externalAuthReceipt
      })
    ).resolves.toEqual({ ready: false, reason: 'account_unverified', field })
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
