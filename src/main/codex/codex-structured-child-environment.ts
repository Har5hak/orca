import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { structuredWorkerChildIdentityEnv } from '../runtime/structured-worker-child-identity-env'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string,
  sessionId: string
): Record<string, string> {
  if (launch.workerAccessMode === 'lab-gateway') {
    return {
      ...(launch.env?.HOME ? { HOME: launch.env.HOME } : {}),
      ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {}),
      [CODEX_SPAWN_TOKEN_ENV]: spawnToken
    }
  }
  return {
    // Only a dispatched structured worker gets the orchestration identity and the Orca CLI on
    // PATH; an ordinary chat session's env passes through untouched.
    ...structuredWorkerChildIdentityEnv(
      sessionId,
      {
        ...launch.env,
        ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {})
      },
      { inheritAmbientPath: launch.environmentMode !== 'exact' }
    ),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
}
