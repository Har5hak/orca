export const CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFRESH_TIMEOUT_MS = 8_000 as const
export const CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFUSAL_CODE =
  'ORCA_CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFUSED' as const

export type CodexLabExternalChatGptAuthBinding = Readonly<{
  dispatchId: string
  sessionId: string
  workspaceId: string
}>

export type CodexLabExternalChatGptLoginParams = Readonly<{
  type: 'chatgptAuthTokens'
  accessToken: string
  chatgptAccountId: string
  chatgptPlanType: string
}>

export type CodexLabExternalChatGptLoginReceipt = Readonly<{
  type: 'chatgptAuthTokens'
  chatgptAccountId: string
  chatgptPlanType: string
}>

export type CodexLabExternalChatGptRefreshRequest = Readonly<{
  reason: 'unauthorized'
  previousAccountId: string
}>

export type CodexLabExternalChatGptRefreshResult = Readonly<{
  accessToken: string
  chatgptAccountId: string
  chatgptPlanType: string
}>

export type CodexLabExternalChatGptRefreshContext = Readonly<
  CodexLabExternalChatGptAuthBinding & {
    reason: 'unauthorized'
    previousAccountId: string
    signal: AbortSignal
  }
>

export type CodexLabExternalChatGptRefreshSource = (
  context: CodexLabExternalChatGptRefreshContext
) => Promise<unknown>

export type CodexLabExternalChatGptAuthHostPort = Readonly<{
  takeInitialLoginParams(): CodexLabExternalChatGptLoginParams
  refresh(candidate: unknown): Promise<CodexLabExternalChatGptRefreshResult>
  dispose(): void
}>

export type CodexLabExternalChatGptAuthHostFactory = () => CodexLabExternalChatGptAuthHostPort

export type CodexLabExternalChatGptCredentialState = Readonly<{
  type: 'chatgptAuthTokens'
  accessToken: string
  chatgptAccountId: string
  chatgptPlanType: string
}>

export type CodexLabExternalChatGptAuthRefusalReason =
  | 'authority_invalid'
  | 'authority_replayed'
  | 'authority_revoked'
  | 'binding_invalid'
  | 'credential_invalid'
  | 'credential_not_fresh'
  | 'host_disposed'
  | 'initial_login_replayed'
  | 'initial_login_required'
  | 'refresh_failed'
  | 'refresh_not_fresh'
  | 'refresh_request_invalid'
  | 'refresh_timeout'

export class CodexLabExternalChatGptAuthRefusal extends Error {
  readonly code = CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFUSAL_CODE

  constructor(readonly reason: CodexLabExternalChatGptAuthRefusalReason) {
    super(`Codex laboratory external ChatGPT auth refused: ${reason}`)
    this.name = 'CodexLabExternalChatGptAuthRefusal'
  }
}

export function refuseCodexLabExternalChatGptAuth(
  reason: CodexLabExternalChatGptAuthRefusalReason
): CodexLabExternalChatGptAuthRefusal {
  return new CodexLabExternalChatGptAuthRefusal(reason)
}
