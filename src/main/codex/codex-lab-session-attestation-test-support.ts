import {
  DISABLED_CODEX_LAB_FEATURES,
  ENABLED_CODEX_LAB_CONFINEMENT_FEATURES
} from '../runtime/orchestration/lab-profile/codex-lab-launch-policy'
import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation'
import {
  createCodexLabExternalChatGptAuthHostFactory,
  type CodexLabExternalChatGptAuthBinding,
  type CodexLabExternalChatGptAuthHostPort
} from './codex-lab-external-chatgpt-auth-authority'
import {
  bindCodexLabExternalChatGptAuthHostFactory,
  claimCodexLabExternalChatGptAuthHostFactory
} from './codex-lab-external-chatgpt-auth-authority-internal'

export function testCodexLabExternalChatGptAuth(input: {
  dispatchId: string
  sessionId: string
  expected: CodexLabAppServerAttestationExpected
  planType?: string
}): Readonly<{
  host: CodexLabExternalChatGptAuthHostPort
  binding: CodexLabExternalChatGptAuthBinding
}> {
  const binding = Object.freeze({
    dispatchId: input.dispatchId,
    sessionId: input.sessionId,
    workspaceId: input.expected.workspaceId
  })
  const credential = Object.freeze({
    type: 'chatgptAuthTokens' as const,
    accessToken: testJwt(),
    chatgptAccountId: input.expected.workspaceId,
    chatgptPlanType: input.planType ?? 'business'
  })
  const factory = createCodexLabExternalChatGptAuthHostFactory({
    binding,
    credential,
    refresh: async () => credential
  })
  if (!bindCodexLabExternalChatGptAuthHostFactory(factory, binding)) {
    throw new Error('test external-auth factory binding failed')
  }
  const host = claimCodexLabExternalChatGptAuthHostFactory(factory, binding)
  if (!host) {
    throw new Error('test external-auth host claim failed')
  }
  return Object.freeze({ host, binding })
}

export function testCodexLabOpenedThread(
  expected: CodexLabAppServerAttestationExpected,
  networkAccess = true,
  threadId = 'thread-lab-attested'
): Record<string, unknown> {
  return {
    cwd: expected.cwd,
    runtimeWorkspaceRoots: [expected.cwd],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    modelProvider: 'openai',
    multiAgentMode: 'explicitRequestOnly',
    activePermissionProfile: {
      id: expected.permissionProfileId,
      extends: ':read-only'
    },
    sandbox: { type: 'readOnly', networkAccess },
    thread: { id: threadId, ephemeral: true },
    instructionSources: [`${expected.cwd}/AGENTS.md`]
  }
}

export function testCodexLabAccount(
  _expected: CodexLabAppServerAttestationExpected,
  type = 'chatgpt',
  planType = 'business'
): Record<string, unknown> {
  return {
    account: { type, email: null, planType },
    requiresOpenaiAuth: true
  }
}

export function testCodexLabRateLimits(
  expected: CodexLabAppServerAttestationExpected,
  overrides: Readonly<Record<string, unknown>> = {},
  planType = 'business'
): Record<string, unknown> {
  return {
    accountId: expected.workspaceId,
    ordinaryUsageAllowed: true,
    rateLimits: { planType },
    ...overrides
  }
}

export function testCodexLabEffectiveConfig(
  expected: CodexLabAppServerAttestationExpected,
  broadenNetwork = false
): Record<string, unknown> {
  return {
    approval_policy: 'never',
    default_permissions: expected.permissionProfileId,
    forced_login_method: 'chatgpt',
    forced_chatgpt_workspace_id: expected.workspaceId,
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
        CODEX_HOME: expected.codexHome,
        HOME: expected.fakeHome,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
      }
    },
    features: {
      network_proxy: true,
      ...Object.fromEntries(DISABLED_CODEX_LAB_FEATURES.map((feature) => [feature, false])),
      ...Object.fromEntries(
        ENABLED_CODEX_LAB_CONFINEMENT_FEATURES.map((feature) => [feature, true])
      )
    },
    skills: { include_instructions: false, bundled: { enabled: false } },
    permissions: {
      [expected.permissionProfileId]: {
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
          domains: broadenNetwork ? { '*': 'allow' } : null,
          mitm: null,
          unix_sockets: { [expected.gatewaySocketPath]: 'allow' }
        }
      }
    }
  }
}

export function testCodexLabPermissionProfiles(
  expected: CodexLabAppServerAttestationExpected,
  allowed = true
): Record<string, unknown> {
  return {
    data: [
      {
        id: expected.permissionProfileId,
        description: 'Disposable read-only laboratory worker',
        allowed
      }
    ],
    nextCursor: null
  }
}

function testJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', source: 'test' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600, source: 'test' })
  ).toString('base64url')
  return `${header}.${payload}.signature`
}
