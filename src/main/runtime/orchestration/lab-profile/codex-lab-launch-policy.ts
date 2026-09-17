export const DISABLED_CODEX_LAB_FEATURES = [
  'apps',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'enable_mcp_apps',
  'hooks',
  'image_generation',
  'in_app_browser',
  'multi_agent',
  'multi_agent_v2',
  'plugin_sharing',
  'plugins',
  'recommended_plugins',
  'remote_plugin',
  'skill_mcp_dependency_install',
  'skill_search',
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
  gatewaySocketPath: string
}): string {
  const featureLines = [
    ...DISABLED_CODEX_LAB_FEATURES.map((feature) => `${feature} = false`),
    ...ENABLED_CODEX_LAB_CONFINEMENT_FEATURES.map((feature) => `${feature} = true`)
  ]
  return [
    'approval_policy = "never"',
    `default_permissions = "${CODEX_LAB_PERMISSION_PROFILE_ID}"`,
    'web_search = "disabled"',
    'cli_auth_credentials_store = "keyring"',
    'forced_login_method = "chatgpt"',
    `forced_chatgpt_workspace_id = ${tomlString(args.workspaceId)}`,
    'check_for_update_on_startup = false',
    'file_opener = "none"',
    '',
    '[history]',
    'persistence = "none"',
    '',
    '[shell_environment_policy]',
    'inherit = "none"',
    'include_only = ["ORCA_LAB_GATEWAY_SOCKET", "ORCA_LAB_GATEWAY_CREDENTIAL"]',
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
    'network_proxy = true',
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
    'enabled = true',
    'allow_local_binding = false',
    'allow_upstream_proxy = false',
    'dangerously_allow_all_unix_sockets = false',
    '',
    `[permissions.${CODEX_LAB_PERMISSION_PROFILE_ID}.network.unix_sockets]`,
    `${tomlString(args.gatewaySocketPath)} = "allow"`,
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
