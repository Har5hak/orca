import type { AgentSessionHandleProvider } from './agent-session-provider-handle'

export type AgentSessionAccountHomeVariable = 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'

/** Account root pinned at launch so a resume cannot drift to another login. */
export type AgentSessionAccountHome = {
  variable: AgentSessionAccountHomeVariable
  /** Host-resolved absolute path in the execution host's own path syntax. */
  path: string
}

export type AgentSessionRequiredPermissionPosture = 'manual'

/** Canonical provider-owned variable; the account path itself remains host-selected. */
export function agentSessionAccountHomeVariableForProvider(
  provider: AgentSessionHandleProvider
): AgentSessionAccountHomeVariable {
  return provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
}
