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
  metadata: Readonly<{ workspaceId: string; planType: string }>
  rollbackIfUnclaimed(): boolean
}>

export type PreparedCodexLabExternalChatGptCredential = Readonly<{
  metadata: Readonly<{ workspaceId: string; planType: string }>
  register(input: {
    dispatchId: string
    sessionId: string
  }): CodexLabExternalChatGptAuthRegistrationHandle
}>

export async function prepareCodexLabExternalChatGptAuthRegistration(input: {
  dispatchId: string
  sessionId: string
  workspaceId?: string
  source: CodexLabChatGptCredentialSource
}): Promise<CodexLabExternalChatGptAuthRegistrationHandle> {
  const prepared = await prepareCodexLabExternalChatGptCredential(input)
  return prepared.register(input)
}

export async function prepareCodexLabExternalChatGptCredential(input: {
  workspaceId?: string
  source: CodexLabChatGptCredentialSource
}): Promise<PreparedCodexLabExternalChatGptCredential> {
  const initial = await readCredential(input.source, input.workspaceId)
  const metadata = Object.freeze({
    workspaceId: initial.chatgptAccountId,
    planType: initial.chatgptPlanType
  })
  let registered = false
  return Object.freeze({
    metadata,
    register(registrationInput): CodexLabExternalChatGptAuthRegistrationHandle {
      if (registered) {
        throw new Error('Codex laboratory source credential registration was replayed.')
      }
      registered = true
      return registerPreparedCredential(registrationInput, input.source, initial, metadata)
    }
  })
}

function registerPreparedCredential(
  input: { dispatchId: string; sessionId: string },
  source: CodexLabChatGptCredentialSource,
  initial: CodexLabExternalChatGptCredentialState,
  metadata: Readonly<{ workspaceId: string; planType: string }>
): CodexLabExternalChatGptAuthRegistrationHandle {
  const binding = Object.freeze({
    dispatchId: input.dispatchId,
    sessionId: input.sessionId,
    workspaceId: initial.chatgptAccountId
  })
  const factory = createCodexLabExternalChatGptAuthHostFactory({
    binding,
    credential: initial,
    refresh: async () => readCredential(source, binding.workspaceId, initial.chatgptPlanType)
  })
  registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory })
  let released = false
  return Object.freeze({
    binding,
    metadata,
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
  expectedWorkspaceId?: string,
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
  const workspaceId = identity?.workspaceAccountId
  const planType = readChatGptPlanType(tokens?.id_token)
  if (
    !auth ||
    !['chatgpt', 'chatgptAuthTokens'].includes(String(auth.auth_mode)) ||
    ['OPENAI_API_KEY', 'agent_identity', 'bedrock_api_key', 'personal_access_token'].some(
      (field) => field in auth && auth[field] !== null
    ) ||
    typeof tokens?.access_token !== 'string' ||
    !tokens.access_token ||
    typeof workspaceId !== 'string' ||
    !workspaceId ||
    (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId) ||
    !isCodexLabWorkspacePlanType(planType) ||
    (expectedPlanType !== undefined && planType !== expectedPlanType)
  ) {
    throw new Error('Codex laboratory source ChatGPT credential does not match the launch.')
  }
  return Object.freeze({
    type: 'chatgptAuthTokens',
    accessToken: tokens.access_token,
    chatgptAccountId: workspaceId,
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
  return isUnknownRecord(candidate) ? candidate : null
}

function isUnknownRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
}
