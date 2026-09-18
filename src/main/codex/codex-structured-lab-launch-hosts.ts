import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  prepareCodexLabExternalChatGptAppServerAuth,
  type CodexLabExternalChatGptAppServerAuth
} from './codex-lab-external-chatgpt-app-server-auth'
import type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation'
import { codexLabAttestationExpectedForLaunch } from './codex-lab-session-attestation'

export async function resolveCodexStructuredLabLaunchHosts(input: {
  identity: AgentSessionJournalIdentity
  resolveLaunch: CodexStructuredSessionAdapterDeps['resolveLaunch']
}): Promise<{
  launch: CodexStructuredLaunch
  externalAuth: CodexLabExternalChatGptAppServerAuth | null
  attestationExpected: CodexLabAppServerAttestationExpected | null
}> {
  const launch = await input.resolveLaunch({ identity: input.identity }).catch((error: unknown) => {
    throw new AgentSessionPreSpawnError(error)
  })
  let externalAuth: CodexLabExternalChatGptAppServerAuth | null = null
  try {
    // Capture the secret-bearing host first so every later launch refusal has
    // one deterministic disposal path before any provider process exists.
    externalAuth = prepareCodexLabExternalChatGptAppServerAuth(launch)
    if (launch.labDynamicToolHost && launch.workerAccessMode !== 'lab-gateway') {
      throw new Error('Codex laboratory dynamic tools require lab-gateway worker access')
    }
    if (externalAuth && launch.workerAccessMode !== 'lab-gateway') {
      throw new Error('Codex laboratory external ChatGPT auth requires lab-gateway worker access')
    }
    if (externalAuth) {
      assertExternalAuthMatchesLabLaunch(input.identity, launch)
    }
    return {
      launch,
      externalAuth,
      attestationExpected: codexLabAttestationExpectedForLaunch(launch)
    }
  } catch (error) {
    externalAuth?.dispose()
    launch.labDynamicToolHost?.dispose()
    throw new AgentSessionPreSpawnError(error)
  }
}

function assertExternalAuthMatchesLabLaunch(
  identity: AgentSessionJournalIdentity,
  launch: CodexStructuredLaunch
): void {
  const auth = launch.labExternalChatGptAuthBindingExpected
  if (
    !auth ||
    auth.sessionId !== identity.sessionId ||
    auth.dispatchId !== launch.labDynamicToolHostAttestationExpected?.dispatchId ||
    auth.workspaceId !== launch.labAppServerAttestationExpected?.workspaceId
  ) {
    throw new Error(
      'Codex laboratory external ChatGPT auth does not match the session, dispatch, and workspace'
    )
  }
}
