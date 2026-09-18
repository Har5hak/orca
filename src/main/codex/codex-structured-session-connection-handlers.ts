import type {
  CodexAppServerConnectionHandlers,
  CodexAppServerServerRequest
} from './codex-app-server-connection-types'
import type { CodexLabExternalChatGptAppServerAuth } from './codex-lab-external-chatgpt-app-server-auth'
import { handleCodexSessionExit } from './codex-structured-session-close'
import type { CodexAcquisitionWindow } from './codex-structured-acquisition-window'
import type { CodexDispatchEchoes } from './codex-structured-dispatch-echo'
import type { CodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

export function createCodexStructuredSessionConnectionHandlers(input: {
  acquisition: CodexAcquisitionWindow
  sessionId: string
  sessions: Map<string, CodexSession>
  dispatchEchoes: CodexDispatchEchoes
  notificationRetries: CodexStructuredNotificationRetry
  externalAuth: CodexLabExternalChatGptAppServerAuth | null
  disposeExternalAuth: () => void
  now?: CodexStructuredSessionAdapterDeps['now']
  onEvent?: CodexStructuredSessionAdapterDeps['onEvent']
  onBackgroundTasksChanged?: CodexStructuredSessionAdapterDeps['onBackgroundTasksChanged']
  deliver: (
    acquisition: CodexAcquisitionWindow,
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ) => void
  handleServerRequest: (sessionId: string, request: CodexAppServerServerRequest) => void
  handleUnhandledFrame: (sessionId: string, kind: string, payload: unknown) => void
}): CodexAppServerConnectionHandlers {
  const { acquisition, sessionId } = input
  return {
    onNotification: (method, params) => {
      const observedAt = isCodexTurnBoundary(method) ? (input.now?.() ?? Date.now()) : undefined
      const dispatchSequenceAtReceipt =
        method === 'turn/started' ? input.dispatchEchoes.latestSequence() : undefined
      input.deliver(
        acquisition,
        sessionId,
        () =>
          input.notificationRetries.handle(
            sessionId,
            method,
            params,
            observedAt,
            dispatchSequenceAtReceipt
          ),
        Buffer.byteLength(JSON.stringify(params ?? null), 'utf8')
      )
    },
    onServerRequest: (request) => {
      if (input.externalAuth?.tryRespond(request)) {
        return
      }
      input.deliver(
        acquisition,
        sessionId,
        () => input.handleServerRequest(sessionId, request),
        Buffer.byteLength(JSON.stringify(request), 'utf8')
      )
    },
    onUnhandledFrame: (kind, payload) =>
      input.deliver(
        acquisition,
        sessionId,
        () => input.handleUnhandledFrame(sessionId, kind, payload),
        Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8')
      ),
    onExit: (error) => {
      try {
        handleCodexSessionExit({
          sessions: input.sessions,
          sessionId,
          connection: acquisition.connection,
          error,
          prompts: acquisition.prompts,
          onBackgroundTasksChanged: input.onBackgroundTasksChanged,
          ...(input.onEvent ? { onEvent: input.onEvent } : {})
        })
      } finally {
        input.notificationRetries.clear(sessionId, acquisition.connection)
      }
    },
    onExitObserved: input.disposeExternalAuth
  }
}

function isCodexTurnBoundary(method: string): boolean {
  return method === 'turn/started' || method === 'turn/completed'
}
