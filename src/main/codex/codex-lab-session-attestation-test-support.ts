import {
  DISABLED_CODEX_LAB_FEATURES,
  ENABLED_CODEX_LAB_CONFINEMENT_FEATURES
} from '../runtime/orchestration/lab-profile/codex-lab-launch-policy'
import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation'

export function testCodexLabOpenedThread(
  expected: CodexLabAppServerAttestationExpected,
  networkAccess = false,
  threadId = 'thread-lab-attested'
): Record<string, unknown> {
  return {
    cwd: expected.cwd,
    runtimeWorkspaceRoots: [expected.cwd],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    modelProvider: 'openai',
    disabledPluginIds: [],
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
  expected: CodexLabAppServerAttestationExpected,
  type = 'chatgpt',
  workspaceId = expected.workspaceId
): Record<string, unknown> {
  return {
    account: { type, email: null, planType: 'business' },
    requiresOpenaiAuth: true,
    workspaceRouting: {
      chatgptAccountId: workspaceId,
      backendOrigin: 'https://chatgpt.com',
      accountRoutingOverride: 'NO_CONSTRAINT'
    }
  }
}

export function testCodexLabEffectiveConfig(
  expected: CodexLabAppServerAttestationExpected,
  networkEnabled = false
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
      network_proxy: false,
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
        workspace_roots: { [expected.cwd]: true },
        filesystem: {
          glob_scan_max_depth: null,
          ':root': 'deny',
          ':minimal': 'read',
          ':tmpdir': 'deny',
          ':slash_tmp': 'deny',
          ':workspace_roots': { '.': 'read' }
        },
        network: {
          enabled: networkEnabled,
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
