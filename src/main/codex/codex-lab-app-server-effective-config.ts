import {
  DISABLED_CODEX_LAB_FEATURES,
  ENABLED_CODEX_LAB_CONFINEMENT_FEATURES
} from '../runtime/orchestration/lab-profile/codex-lab-launch-policy'
import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation-contract'
import {
  exactRecord,
  invalid,
  isAbsent,
  isEmptyOrAbsentRecord,
  isRecord,
  record,
  sameStrings,
  type ValidationFailure
} from './codex-lab-app-server-value'
import { validateCodexLabPermissionConfig } from './codex-lab-app-server-permission-config'

const EMPTY_HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt'
] as const

const ABSENT_EXECUTION_SURFACES = [
  'approvals_reviewer',
  'auto_review',
  'sandbox_mode',
  'sandbox_workspace_write',
  'allow_symlinked_codex_home',
  'notify',
  'instructions',
  'developer_instructions',
  'browser_use',
  'computer_use',
  'desktop',
  'apps',
  'agents',
  'goals',
  'memories',
  'orchestrator',
  'tool_suggest',
  'windows',
  'audio',
  'realtime',
  'experimental_use_unified_exec_tool',
  'experimental_realtime_ws_base_url',
  'experimental_realtime_webrtc_call_base_url',
  'chatgpt_base_url'
] as const

export function readCodexLabEffectiveConfig(value: unknown): Record<string, unknown> | null {
  const response = exactRecord(value, ['config', 'origins', 'layers'])
  if (!response || !isRecord(response.config) || !isRecord(response.origins)) {
    return null
  }
  return Array.isArray(response.layers) ? response.config : null
}

export function validateCodexLabEffectiveConfig(
  config: Record<string, unknown>,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  const scalarFailure = validateScalarConfig(config, expected)
  if (scalarFailure) {
    return scalarFailure
  }
  const history = knownRecord(config.history, ['persistence', 'max_bytes'])
  if (!history || history.persistence !== 'none' || !isAbsent(history.max_bytes)) {
    return invalid('config.history')
  }
  const analytics = exactRecord(config.analytics, ['enabled'])
  if (!analytics || analytics.enabled !== false) {
    return invalid('config.analytics')
  }
  const feedback = exactRecord(config.feedback, ['enabled'])
  if (!feedback || feedback.enabled !== false) {
    return invalid('config.feedback')
  }
  const telemetryFailure = validateTelemetryConfig(config.otel)
  if (telemetryFailure) {
    return telemetryFailure
  }
  const tools = knownRecord(config.tools, [
    'web_search',
    'experimental_request_user_input',
    'update_plan'
  ])
  if (
    !tools ||
    !(isAbsent(tools.web_search) || tools.web_search === false) ||
    !isAbsent(tools.experimental_request_user_input) ||
    !isAbsent(tools.update_plan)
  ) {
    return invalid('config.tools')
  }
  if (!emptyRecord(config.mcp_servers)) {
    return invalid('config.mcp_servers')
  }
  if (!emptyHooks(config.hooks)) {
    return invalid('config.hooks')
  }
  const shellFailure = validateShellEnvironment(config.shell_environment_policy, expected)
  if (shellFailure) {
    return shellFailure
  }
  const featureFailure = validateFeatures(config.features)
  if (featureFailure) {
    return featureFailure
  }
  const skills = knownRecord(config.skills, ['include_instructions', 'bundled', 'config'])
  const bundled = skills ? exactRecord(skills.bundled, ['enabled']) : null
  if (
    !skills ||
    skills.include_instructions !== false ||
    bundled?.enabled !== false ||
    !(isAbsent(skills.config) || sameStrings(skills.config, []))
  ) {
    return invalid('config.skills')
  }
  return validateCodexLabPermissionConfig(config.permissions, expected)
}

function validateTelemetryConfig(value: unknown): ValidationFailure | null {
  const otel = knownRecord(value, [
    'tool_result',
    'log_user_prompt',
    'environment',
    'exporter',
    'trace_exporter',
    'metrics_exporter',
    'span_attributes',
    'tracestate'
  ])
  if (
    !otel ||
    otel.log_user_prompt !== false ||
    otel.exporter !== 'none' ||
    otel.trace_exporter !== 'none' ||
    otel.metrics_exporter !== 'none' ||
    !isAbsent(otel.environment) ||
    !isAbsent(otel.span_attributes) ||
    !isAbsent(otel.tracestate)
  ) {
    return invalid('config.otel')
  }
  return null
}

function validateScalarConfig(
  config: Record<string, unknown>,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  const exactValues: readonly (readonly [string, unknown])[] = [
    ['approval_policy', 'never'],
    ['default_permissions', expected.permissionProfileId],
    ['forced_login_method', 'chatgpt'],
    ['web_search', 'disabled'],
    ['cli_auth_credentials_store', 'keyring'],
    ['check_for_update_on_startup', false],
    ['file_opener', 'none'],
    ['allow_login_shell', false]
  ]
  for (const [field, expectedValue] of exactValues) {
    if (config[field] !== expectedValue) {
      return invalid(`config.${field}`)
    }
  }
  for (const field of ABSENT_EXECUTION_SURFACES) {
    if (!isAbsent(config[field])) {
      return invalid(`config.${field}`)
    }
  }
  if (!isAbsent(config.openai_base_url)) {
    return invalid('config.openai_base_url')
  }
  if (!isAbsent(config.model_provider) && config.model_provider !== 'openai') {
    return invalid('config.model_provider')
  }
  if (!isEmptyOrAbsentRecord(config.model_providers)) {
    return invalid('config.model_providers')
  }
  for (const field of ['plugins', 'marketplaces']) {
    if (!isEmptyOrAbsentRecord(config[field])) {
      return invalid(`config.${field}`)
    }
  }
  if (!workspaceIdMatches(config.forced_chatgpt_workspace_id, expected.workspaceId)) {
    return invalid('config.forced_chatgpt_workspace_id')
  }
  return null
}

function validateShellEnvironment(
  value: unknown,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  const shell = knownRecord(value, [
    'inherit',
    'include_only',
    'ignore_default_excludes',
    'experimental_use_profile',
    'set',
    'exclude',
    'filters'
  ])
  if (
    !shell ||
    shell.inherit !== 'none' ||
    !sameStrings(shell.include_only, []) ||
    shell.ignore_default_excludes !== false ||
    shell.experimental_use_profile !== false ||
    !isAbsent(shell.exclude) ||
    !isAbsent(shell.filters)
  ) {
    return invalid('config.shell_environment_policy')
  }
  const variables = exactRecord(shell.set, ['CODEX_HOME', 'HOME', 'PATH'])
  if (
    !variables ||
    variables.CODEX_HOME !== expected.codexHome ||
    variables.HOME !== expected.fakeHome ||
    variables.PATH !== '/usr/bin:/bin:/usr/sbin:/sbin'
  ) {
    return invalid('config.shell_environment_policy.set')
  }
  return null
}

function validateFeatures(value: unknown): ValidationFailure | null {
  const expectedKeys = [
    'network_proxy',
    ...DISABLED_CODEX_LAB_FEATURES,
    ...ENABLED_CODEX_LAB_CONFINEMENT_FEATURES
  ]
  const features = record(value)
  if (!features) {
    return invalid('config.features')
  }
  const expected = new Set(expectedKeys)
  const unknown = Object.keys(features).find((key) => !expected.has(key))
  if (unknown) {
    return invalid(`config.features.${unknown}`)
  }
  if (Object.keys(features).length !== expected.size || features.network_proxy !== false) {
    return invalid('config.features')
  }
  for (const feature of DISABLED_CODEX_LAB_FEATURES) {
    if (features[feature] !== false) {
      return invalid(`config.features.${feature}`)
    }
  }
  for (const feature of ENABLED_CODEX_LAB_CONFINEMENT_FEATURES) {
    if (features[feature] !== true) {
      return invalid(`config.features.${feature}`)
    }
  }
  return null
}

function workspaceIdMatches(value: unknown, workspaceId: string): boolean {
  return value === workspaceId || sameStrings(value, [workspaceId])
}

function emptyRecord(value: unknown): boolean {
  const object = record(value)
  return Boolean(object && Object.keys(object).length === 0)
}

function emptyHooks(value: unknown): boolean {
  const hooks = knownRecord(value, [...EMPTY_HOOK_EVENTS, 'state'])
  if (!hooks || !isEmptyOrAbsentRecord(hooks.state)) {
    return false
  }
  return EMPTY_HOOK_EVENTS.every((event) => sameStrings(hooks[event], []))
}

function knownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const object = record(value)
  if (!object || Object.keys(object).some((key) => !keys.includes(key))) {
    return null
  }
  return object
}
