import type {
  CodexAppServerConnection,
  CodexAppServerServerRequest
} from './codex-app-server-connection-types'
import type { CodexLabExternalChatGptAuthHostPort } from './codex-lab-external-chatgpt-auth-contract'
import { isCodexLabExternalChatGptAuthHostBoundTo } from './codex-lab-external-chatgpt-auth-authority'
import { exactCodexLabExternalChatGptOwnDataRecord } from './codex-lab-external-chatgpt-auth-validation'
import { CODEX_AUTH_TOKEN_REFRESH_METHOD } from './codex-server-request-disposition'
import type { CodexStructuredLaunch } from './codex-structured-session-state'

const AUTH_RESPONSE_ERROR_CODE = -32_001
const AUTH_RESPONSE_ERROR_MESSAGE = 'Orca could not refresh app-server auth tokens'
const AUTH_LOGIN_ERROR_MESSAGE = 'Codex laboratory external ChatGPT login failed'

export type CodexLabExternalChatGptAppServerAuth = Readonly<{
  authenticate(connection: CodexAppServerConnection, timeoutMs?: number): Promise<void>
  tryRespond(request: CodexAppServerServerRequest): boolean
  dispose(): void
}>

/** Validates and captures the opaque host before any provider process exists. */
export function prepareCodexLabExternalChatGptAppServerAuth(
  launch: Pick<
    CodexStructuredLaunch,
    'labExternalChatGptAuthHost' | 'labExternalChatGptAuthBindingExpected'
  >
): CodexLabExternalChatGptAppServerAuth | null {
  const host = launch.labExternalChatGptAuthHost
  const expected = launch.labExternalChatGptAuthBindingExpected
  if (!host && !expected) {
    return null
  }
  if (
    !host ||
    !expected ||
    !Object.isFrozen(expected) ||
    !isCodexLabExternalChatGptAuthHostBoundTo(host, expected)
  ) {
    host?.dispose()
    throw new Error('Codex laboratory external ChatGPT auth binding is invalid')
  }
  return createSessionAuth(host)
}

/**
 * Installs process-local external ChatGPT auth on the raw app-server
 * connection. This must run before the laboratory guard hides login RPCs and
 * before a thread can be opened or published.
 */
export async function authenticateCodexLabExternalChatGptAppServer(
  connection: Pick<CodexAppServerConnection, 'request'>,
  host: CodexLabExternalChatGptAuthHostPort,
  timeoutMs?: number
): Promise<void> {
  const params = host.takeInitialLoginParams()
  let result: unknown
  try {
    result = await connection.request('account/login/start', params, { timeoutMs })
  } catch {
    // The child has seen the token and therefore cannot be trusted to keep a
    // rejection message secret-free. Never retain its error as a cause.
    throw new Error(AUTH_LOGIN_ERROR_MESSAGE)
  }
  const response = exactCodexLabExternalChatGptOwnDataRecord(result, ['type'])
  if (response?.type !== 'chatgptAuthTokens') {
    throw new Error('Codex laboratory external ChatGPT login response is invalid')
  }
}

/**
 * Handles the one provider request that must bypass the acquisition journal.
 * Returning false leaves every other server request on its existing path.
 * A handled promise never rejects: the app-server receives a bounded generic
 * error instead of host errors or credential material.
 */
export function tryRespondToCodexLabExternalChatGptRefresh(
  connection: Pick<CodexAppServerConnection, 'respond' | 'respondWithError'>,
  host: CodexLabExternalChatGptAuthHostPort,
  request: CodexAppServerServerRequest
): false | Promise<void> {
  if (request.method !== CODEX_AUTH_TOKEN_REFRESH_METHOD) {
    return false
  }
  return Promise.resolve()
    .then(() => host.refresh(request.params))
    .then(
      (result) => connection.respond(request.id, result),
      () =>
        connection.respondWithError(
          request.id,
          AUTH_RESPONSE_ERROR_CODE,
          AUTH_RESPONSE_ERROR_MESSAGE
        )
    )
}

function createSessionAuth(
  host: CodexLabExternalChatGptAuthHostPort
): CodexLabExternalChatGptAppServerAuth {
  let connection: CodexAppServerConnection | null = null
  let earlyRefresh: CodexAppServerServerRequest | null = null
  let earlyRefreshOverflow = false
  return Object.freeze({
    async authenticate(upstream: CodexAppServerConnection, timeoutMs?: number): Promise<void> {
      connection = upstream
      if (earlyRefresh) {
        upstream.respondWithError(
          earlyRefresh.id,
          AUTH_RESPONSE_ERROR_CODE,
          AUTH_RESPONSE_ERROR_MESSAGE
        )
        throw new Error(
          earlyRefreshOverflow
            ? 'Codex app-server requested repeated token refresh before external auth login'
            : 'Codex app-server requested token refresh before external auth login'
        )
      }
      await authenticateCodexLabExternalChatGptAppServer(upstream, host, timeoutMs)
    },
    tryRespond(request: CodexAppServerServerRequest): boolean {
      if (request.method !== CODEX_AUTH_TOKEN_REFRESH_METHOD) {
        return false
      }
      if (connection) {
        void tryRespondToCodexLabExternalChatGptRefresh(connection, host, request)
      } else if (!earlyRefresh) {
        earlyRefresh = request
      } else {
        earlyRefreshOverflow = true
      }
      return true
    },
    dispose(): void {
      host.dispose()
      connection = null
      earlyRefresh = null
    }
  })
}
