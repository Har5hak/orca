import type { CodexAppServerServerRequest } from './codex-app-server-connection'
import {
  CODEX_DYNAMIC_TOOL_CALL_METHOD,
  disposeCodexServerRequest
} from './codex-server-request-disposition'
import {
  isCodexLabDynamicToolCallId,
  type CodexLabDynamicToolInvocation
} from './codex-lab-dynamic-tool-host'
import { mapCodexLabDynamicToolCall } from './codex-lab-dynamic-tool-contract'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import * as codexRewind from './codex-structured-rewind'
import type { CodexSession, CodexStructuredSessionEvent } from './codex-structured-session-state'
import { readCodexThreadId } from './codex-structured-thread-facts'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'

type EmitCodexEvent = (
  session: CodexSession,
  event: CodexStructuredSessionEvent
) => CodexJournalTranslationAdmission

/** One live notification's journal entry: rewind bookkeeping, cancellation deferral, delivery. */
export function translateCodexNotification(input: {
  sessionId: string
  session: CodexSession
  method: string
  params: unknown
  observedAt?: number
  dispatchSequenceAtReceipt?: number
  turnCancellation: Pick<CodexStructuredTurnCancellation, 'handleNotification'>
  emit: EmitCodexEvent
}): CodexJournalTranslationAdmission {
  const { sessionId, session, method, params, observedAt, dispatchSequenceAtReceipt } = input
  codexRewind.observeCodexRewindActivity(session, method, params)
  if (input.turnCancellation.handleNotification(sessionId, session, method, params, observedAt)) {
    return { accepted: true }
  }
  return deliverCodexNotification(
    sessionId,
    session,
    method,
    params,
    input.emit,
    observedAt,
    dispatchSequenceAtReceipt
  )
}

export function deliverCodexNotification(
  sessionId: string,
  session: CodexSession | undefined,
  method: string,
  params: unknown,
  emit: EmitCodexEvent,
  observedAt?: number,
  dispatchSequenceAtReceipt?: number
): CodexJournalTranslationAdmission {
  if (!session) {
    return { accepted: true }
  }
  const threadId = readCodexThreadId(params) ?? session.threadId
  // Dispatch identity settles on the user-message echo inside the translator,
  // which is where the ordinal a replay will compute is minted.
  return emit(session, {
    type: 'notification',
    sessionId,
    threadId,
    method,
    params,
    ...(observedAt !== undefined ? { observedAt } : {}),
    ...(dispatchSequenceAtReceipt !== undefined ? { dispatchSequenceAtReceipt } : {})
  })
}

export function deliverCodexServerRequest(
  sessionId: string,
  session: CodexSession | undefined,
  request: CodexAppServerServerRequest,
  emit: EmitCodexEvent
): CodexJournalTranslationAdmission {
  if (!session) {
    return { accepted: true }
  }
  const labInvocation = readAdmittedLabDynamicToolInvocation(session, request)
  if (labInvocation) {
    const admission = emit(session, {
      type: 'server-request',
      sessionId,
      threadId: session.threadId,
      method: request.method,
      params: request.params
    })
    if (!admission.accepted) {
      session.connection.respond(request.id, { contentItems: [], success: false })
      void session.forceCloseUnexpected?.(
        new Error(
          `Codex server request ${request.method} could not be durably recorded (${admission.reason})`
        )
      )
      return admission
    }
    const host = session.labDynamicToolHost
    if (!host) {
      session.connection.respond(request.id, { contentItems: [], success: false })
      return admission
    }
    void Promise.resolve()
      .then(() => host.invoke(labInvocation))
      .then(
        (response) => session.connection.respond(request.id, response),
        () => session.connection.respond(request.id, { contentItems: [], success: false })
      )
    return admission
  }
  const disposition = disposeCodexServerRequest(session.prompts, session.connection, request)
  const threadId = readCodexThreadId(request.params) ?? session.threadId
  if (disposition.kind === 'responded') {
    const admission = emit(session, {
      type: 'server-request',
      sessionId,
      threadId,
      method: request.method,
      params: request.params
    })
    if (!admission.accepted) {
      void session.forceCloseUnexpected?.(
        new Error(
          `Codex server request ${request.method} could not be durably recorded (${admission.reason})`
        )
      )
    }
    return admission
  }
  const prompt = disposition.prompt
  const admission = emit(session, {
    type: 'prompt',
    sessionId,
    threadId: prompt.threadId,
    method: request.method,
    params: request.params,
    codexItemId: prompt.codexItemId,
    promptKey: prompt.promptKey
  })
  if (!admission.accepted) {
    session.prompts.forget(prompt)
    session.connection.respondWithError(
      request.id,
      -32001,
      `Orca could not durably record ${request.method} prompt (${admission.reason})`
    )
  }
  return admission
}

function readAdmittedLabDynamicToolInvocation(
  session: CodexSession,
  request: CodexAppServerServerRequest
): CodexLabDynamicToolInvocation | null {
  if (
    request.method !== CODEX_DYNAMIC_TOOL_CALL_METHOD ||
    session.ended ||
    session.workerAccessMode !== 'lab-gateway' ||
    !session.labDynamicToolHost
  ) {
    return null
  }
  const params = plainObject(request.params)
  if (!params) {
    return null
  }
  const threadId = ownValue(params, 'threadId')
  const turnId = ownValue(params, 'turnId')
  const callId = ownValue(params, 'callId')
  const namespace = ownValue(params, 'namespace')
  const tool = ownValue(params, 'tool')
  const argumentsValue = ownValue(params, 'arguments')
  if (
    threadId !== session.threadId ||
    typeof turnId !== 'string' ||
    !session.activeTurnIds?.has(turnId) ||
    !isCodexLabDynamicToolCallId(callId) ||
    namespace !== null ||
    typeof tool !== 'string' ||
    !Object.hasOwn(params, 'arguments')
  ) {
    return null
  }
  if (!mapCodexLabDynamicToolCall(namespace, tool, argumentsValue).ok) {
    return null
  }
  return {
    callId,
    namespace,
    tool,
    arguments: argumentsValue
  }
}

function plainObject(value: unknown): object | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value : null
}

function ownValue(value: object, key: string): unknown {
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

export function deliverCodexUnhandledFrame(
  sessionId: string,
  session: CodexSession | undefined,
  kind: string,
  payload: unknown,
  emit: EmitCodexEvent
): CodexJournalTranslationAdmission {
  if (!session) {
    return { accepted: true }
  }
  const admission = emit(session, {
    type: 'provider-frame',
    sessionId,
    threadId: readCodexThreadId(payload) ?? session.threadId,
    kind,
    payload
  })
  if (!admission.accepted) {
    // There is no safe replay cursor for malformed/unhandled frames. Close the
    // provider so host recovery records a truthful terminal failure instead of
    // silently dropping the diagnostic under sink backpressure.
    void session.forceCloseUnexpected?.(
      new Error(`Codex provider frame ${kind} could not be durably recorded (${admission.reason})`)
    )
  }
  return admission
}
