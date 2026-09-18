import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { CodexLabAppServerMethodRefusedError } from './codex-lab-app-server-attestation-contract'

/**
 * The complete client-request surface a fresh laboratory session needs before
 * it is published and while it runs. A method is added only when a production
 * callsite proves the lab profile needs it.
 */
export const CODEX_LAB_ALLOWED_APP_SERVER_REQUEST_METHODS = Object.freeze([
  'account/read',
  'account/rateLimits/read',
  'config/read',
  'configRequirements/read',
  'permissionProfile/list',
  'thread/start',
  'turn/start',
  'turn/interrupt'
] as const)

const ALLOWED_REQUEST_METHODS = new Set<string>(CODEX_LAB_ALLOWED_APP_SERVER_REQUEST_METHODS)

/**
 * Installs the laboratory host boundary after the app-server handshake. The
 * provider can still receive responses to requests it initiated, but no later
 * host request or notification reaches the transport unless this boundary
 * explicitly admits it.
 */
export function guardCodexAppServerConnectionForWorkerAccess(
  upstream: CodexAppServerConnection,
  workerAccessMode: 'orca-cli' | 'lab-gateway' | undefined
): CodexAppServerConnection {
  if (workerAccessMode !== 'lab-gateway') {
    return upstream
  }

  return {
    get pid() {
      return upstream.pid
    },
    get closed() {
      return upstream.closed
    },
    request: (method, params, options) => {
      if (!ALLOWED_REQUEST_METHODS.has(method)) {
        return Promise.reject(new CodexLabAppServerMethodRefusedError(method))
      }
      return upstream.request(method, params, options)
    },
    notify: (method) => {
      throw new CodexLabAppServerMethodRefusedError(method)
    },
    respond: (id, result) => upstream.respond(id, result),
    respondWithError: (id, code, message) => upstream.respondWithError(id, code, message),
    ...(upstream.pauseReading ? { pauseReading: () => upstream.pauseReading?.() } : {}),
    ...(upstream.resumeReading ? { resumeReading: () => upstream.resumeReading?.() } : {}),
    close: () => upstream.close()
  }
}
