export const DISABLED_CODEX_LAB_FEATURES = [
  'apps',
  'artifact',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'computer_use',
  'default_mode_request_user_input',
  'enable_mcp_apps',
  'external_agent_memory_import',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_chat',
  'in_app_dictation',
  'in_app_local_automation',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'plugin_sharing',
  'plugins',
  'recommended_plugins',
  'remote_plugin',
  'shell_snapshot',
  'skill_mcp_dependency_install',
  'skill_search',
  'sleep_tool',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'auth_elicitation',
  'view_image',
  'workspace_dependencies'
] as const

export const ENABLED_CODEX_LAB_CONFINEMENT_FEATURES = ['skip_host_skill_discovery'] as const

export const UNVERIFIED_CODEX_LAB_BOUNDARIES = [
  'effective-config-enforcement',
  'filesystem-confinement',
  'network-confinement',
  'process-spawn',
  'provider-session'
] as const

export const CODEX_LAB_PERMISSION_PROFILE_ID = 'orca-lab-readonly-v1' as const

/** Arguments passed to the already-pinned executable. Policy lives in the isolated config and
 *  named thread permission profile; adding legacy `--sandbox` would disable that profile. */
export function buildCodexLabArgv(): readonly string[] {
  return ['--strict-config', 'app-server']
}

export function renderCodexLabConfig(args: {
  workspaceId: string
  codexHome: string
  fakeHome: string
  worktreePath: string
}): string {
  const featureLines = [
    ...DISABLED_CODEX_LAB_FEATURES.map((feature) => `${feature} = false`),
    ...ENABLED_CODEX_LAB_CONFINEMENT_FEATURES.map((feature) => `${feature} = true`)
  ]
  return [
    'approval_policy = "never"',
    'allow_login_shell = false',
    `default_permissions = "${CODEX_LAB_PERMISSION_PROFILE_ID}"`,
    'web_search = "disabled"',
    'cli_auth_credentials_store = "keyring"',
    'forced_login_method = "chatgpt"',
    `forced_chatgpt_workspace_id = ${tomlString(args.workspaceId)}`,
    'check_for_update_on_startup = false',
    'file_opener = "none"',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[feedback]',
    'enabled = false',
    '',
    '[otel]',
    'log_user_prompt = false',
    'exporter = "none"',
    'trace_exporter = "none"',
    'metrics_exporter = "none"',
    '',
    '[history]',
    'persistence = "none"',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'include_only = []',
    'ignore_default_excludes = false',
    'experimental_use_profile = false',
    '',
    '[shell_environment_policy.set]',
    `CODEX_HOME = ${tomlString(args.codexHome)}`,
    `HOME = ${tomlString(args.fakeHome)}`,
    'PATH = "/usr/bin:/bin:/usr/sbin:/sbin"',
    '',
    '[tools]',
    'web_search = false',
    '',
    '[features]',
    'network_proxy = false',
    ...featureLines,
    '',
    `[permissions.${CODEX_LAB_PERMISSION_PROFILE_ID}]`,
    'description = "Orca attended disposable read-only laboratory worker"',
    'extends = ":read-only"',
    '',
    `[permissions.${CODEX_LAB_PERMISSION_PROFILE_ID}.workspace_roots]`,
    `${tomlString(args.worktreePath)} = true`,
    '',
    `[permissions.${CODEX_LAB_PERMISSION_PROFILE_ID}.filesystem]`,
    '":root" = "deny"',
    '":minimal" = "read"',
    '":tmpdir" = "deny"',
    '":slash_tmp" = "deny"',
    '',
    `[permissions.${CODEX_LAB_PERMISSION_PROFILE_ID}.filesystem.":workspace_roots"]`,
    '"." = "read"',
    '',
    `[permissions.${CODEX_LAB_PERMISSION_PROFILE_ID}.network]`,
    'enabled = false',
    'allow_local_binding = false',
    'allow_upstream_proxy = false',
    'dangerously_allow_all_unix_sockets = false',
    '',
    `[permissions.${CODEX_LAB_PERMISSION_PROFILE_ID}.network.unix_sockets]`,
    '',
    '[mcp_servers]',
    '',
    '[hooks]',
    '',
    '[skills]',
    'include_instructions = false',
    '',
    '[skills.bundled]',
    'enabled = false',
    ''
  ].join('\n')
}

function tomlString(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\f', '\\f')
    .replaceAll('\r', '\\r')}"`
}
