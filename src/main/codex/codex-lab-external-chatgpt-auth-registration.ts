import { readCodexAuthIdentity } from '../codex-accounts/codex-auth-identity'
import {
  createCodexLabExternalChatGptAuthHostFactory,
  type CodexLabExternalChatGptAuthBinding
} from './codex-lab-external-chatgpt-auth-authority'
import type { CodexLabExternalChatGptCredentialState } from './codex-lab-external-chatgpt-auth-contract'
import type { CodexLabChatGptCredentialSource } from './codex-lab-chatgpt-credential-host-ports'
import { isCodexLabWorkspacePlanType } from './codex-lab-app-server-account'
import {
  registerCodexLabExternalChatGptAuthAuthority,
  releaseCodexLabExternalChatGptAuthAuthorityIfUnclaimed
} from '../runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-registry-internal'

export type CodexLabExternalChatGptAuthRegistrationHandle = Readonly<{
  binding: CodexLabExternalChatGptAuthBinding
  rollbackIfUnclaimed(): boolean
}>

export async function prepareCodexLabExternalChatGptAuthRegistration(input: {
  dispatchId: string
  sessionId: string
  workspaceId: string
  source: CodexLabChatGptCredentialSource
}): Promise<CodexLabExternalChatGptAuthRegistrationHandle> {
  const binding = Object.freeze({
    dispatchId: input.dispatchId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId
  })
  const initial = await readCredential(input.source, binding)
  const factory = createCodexLabExternalChatGptAuthHostFactory({
    binding,
    credential: initial,
    refresh: async () => readCredential(input.source, binding, initial.chatgptPlanType)
  })
  registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory })
  let released = false
  return Object.freeze({
    binding,
    rollbackIfUnclaimed(): boolean {
      if (released) {
        return false
      }
      const rolledBack = releaseCodexLabExternalChatGptAuthAuthorityIfUnclaimed(
        binding.sessionId,
        binding.dispatchId
      )
      if (rolledBack) {
        released = true
      }
      return rolledBack
    }
  })
}

async function readCredential(
  source: CodexLabChatGptCredentialSource,
  binding: CodexLabExternalChatGptAuthBinding,
  expectedPlanType?: string
): Promise<CodexLabExternalChatGptCredentialState> {
  let raw: string | null
  try {
    raw = await source.readCredential()
  } catch {
    throw new Error('Codex laboratory source ChatGPT credential is unavailable.')
  }
  const auth = parseRecord(raw)
  const tokens = parseRecord(auth?.tokens)
  const identity = raw ? readCodexAuthIdentity(raw) : null
  const planType = readChatGptPlanType(tokens?.id_token)
  if (
    !auth ||
    !['chatgpt', 'chatgptAuthTokens'].includes(String(auth.auth_mode)) ||
    ['OPENAI_API_KEY', 'agent_identity', 'bedrock_api_key', 'personal_access_token'].some(
      (field) => field in auth
    ) ||
    typeof tokens?.access_token !== 'string' ||
    !tokens.access_token ||
    identity?.workspaceAccountId !== binding.workspaceId ||
    !isCodexLabWorkspacePlanType(planType) ||
    (expectedPlanType !== undefined && planType !== expectedPlanType)
  ) {
    throw new Error('Codex laboratory source ChatGPT credential does not match the launch.')
  }
  return Object.freeze({
    type: 'chatgptAuthTokens',
    accessToken: tokens.access_token,
    chatgptAccountId: binding.workspaceId,
    chatgptPlanType: planType
  })
}

function readChatGptPlanType(candidate: unknown): string | null {
  if (typeof candidate !== 'string') {
    return null
  }
  const payload = candidate.split('.')[1]
  if (!payload) {
    return null
  }
  try {
    const claims = parseRecord(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    const auth = parseRecord(claims?.['https://api.openai.com/auth'])
    const plan = auth?.chatgpt_plan_type
    return typeof plan === 'string' && plan.trim() ? plan.trim().toLowerCase() : null
  } catch {
    return null
  }
}

function parseRecord(candidate: unknown): Record<string, unknown> | null {
  if (typeof candidate === 'string') {
    try {
      return parseRecord(JSON.parse(candidate))
    } catch {
      return null
    }
  }
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null
}
