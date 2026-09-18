import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { CodexLabAppServerMethodRefusedError } from './codex-lab-app-server-attestation-contract'
import type { CodexLabCapacityPolicy } from '../runtime/orchestration/lab-profile/codex-lab-usage-authorization'

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
  'model/list',
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
  workerAccessMode: 'orca-cli' | 'lab-gateway' | undefined,
  guardOptions: Readonly<{
    capacityPolicy?: CodexLabCapacityPolicy
    now?: () => number
  }> = {}
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
    request: (method, params, requestOptions) => {
      if (!ALLOWED_REQUEST_METHODS.has(method)) {
        return Promise.reject(new CodexLabAppServerMethodRefusedError(method))
      }
      if (method === 'turn/start') {
        if (ownValue(params, 'serviceTier') !== 'default') {
          return Promise.reject(new CodexLabTurnStartRefusedError('fast_tier_forbidden'))
        }
        const capacityPolicy = guardOptions.capacityPolicy
        if (
          capacityPolicy?.route === 'authorized-metered-workspace' &&
          Date.parse(capacityPolicy.expiresAt) <= (guardOptions.now?.() ?? Date.now())
        ) {
          return Promise.reject(new CodexLabTurnStartRefusedError('metered_authorization_expired'))
        }
      }
      return upstream.request(method, params, requestOptions)
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

export class CodexLabTurnStartRefusedError extends Error {
  constructor(readonly reason: 'fast_tier_forbidden' | 'metered_authorization_expired') {
    super(`Codex laboratory turn/start refused: ${reason}`)
    this.name = 'CodexLabTurnStartRefusedError'
  }
}

function ownValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined
}
