import {
  AgentSessionAcquisitionRefusal,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  closeFailedCodexAcquisition,
  stopSupersededCodexAcquisition
} from './codex-structured-acquisition-lifecycle'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { CodexSubagentExecutions } from './codex-subagent-executions'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { guardCodexAppServerConnectionForWorkerAccess } from './codex-lab-app-server-connection-guard'
import type { CodexLabExternalChatGptAppServerAuth } from './codex-lab-external-chatgpt-app-server-auth'
import { attestCodexLabOpenedThread } from './codex-lab-session-attestation'
import { codexProcessIdentity, codexProviderHandleLink } from './codex-structured-owner-identity'
import { buildCodexStructuredChildEnvironment } from './codex-structured-child-environment'
import { openCodexThread } from './codex-structured-thread-open'
import { closeCodexPublishedSession } from './codex-structured-session-close'
import { createCodexStructuredSessionConnectionHandlers } from './codex-structured-session-connection-handlers'
import { resolveCodexStructuredLabLaunchHosts } from './codex-structured-lab-launch-hosts'
import {
  readCodexStructuredSessionOptionCatalog,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import {
  reconcileCodexFastModeOption,
  reportedCodexThreadOptions
} from './codex-structured-fast-mode'
import {
  codexSessionLifecycle,
  mintCodexAcquisitionGeneration,
  type CodexAcquisitionRegistry,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'
import type { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'
import type { CodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { deliverCodexServerRequest } from './codex-structured-provider-events'
import { isCodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'

export async function acquireCodexStructuredSession(input: {
  input: StructuredAgentSessionAcquireInput
  deps: CodexStructuredSessionAdapterDeps
  sessions: Map<string, CodexSession>
  acquisitions: CodexAcquisitionRegistry
  turnCancellation: CodexStructuredTurnCancellation
  notificationRetries: CodexStructuredNotificationRetry
  deliver: (
    acquisition: CodexAcquisitionAttempt['window'],
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ) => void
  handleServerRequest: (
    sessionId: string,
    request: Parameters<typeof deliverCodexServerRequest>[2]
  ) => void
  handleUnhandledFrame: (sessionId: string, kind: string, payload: unknown) => void
  forceCloseUnexpected: (
    sessionId: string,
    fence: number,
    acquisitionGeneration: string,
    reason: Error
  ) => Promise<boolean>
}): Promise<AgentSessionAcquisition> {
  const {
    input: acquireInput,
    deps,
    sessions,
    acquisitions,
    turnCancellation,
    notificationRetries
  } = input
  const sessionId = acquireInput.identity.sessionId
  const { previousAttempt, attempt } = acquisitions.start(sessionId)
  const acquisition = attempt.window
  let unbindReadingControl: (() => void) | undefined
  let labDynamicToolHost: CodexSession['labDynamicToolHost']
  let labDynamicToolHostPublished = false
  let labExternalChatGptAuth: CodexLabExternalChatGptAppServerAuth | null = null
  const disposeExternalAuthHost = (): void => labExternalChatGptAuth?.dispose()
  let primaryThreadId =
    acquireInput.identity.providerHandle.kind === 'codex'
      ? acquireInput.identity.providerHandle.threadId
      : null
  const subagentExecutions = new CodexSubagentExecutions()
  const dispatchEchoes = createCodexDispatchEchoes()
  const translator = acquireInput.events
    ? createCodexJournalTranslator({
        sink: acquireInput.events,
        sessionId,
        ...(deps.now ? { now: deps.now } : {}),
        primaryThreadId: () => primaryThreadId,
        dispatchRequestOrigin: (clientMessageId) => dispatchEchoes.requestOrigin(clientMessageId),
        subagentExecutions,
        bindPromptItemId: (journalItemId, threadId, promptKey, turnId) =>
          acquisition.prompts.bindJournalItemId(journalItemId, threadId, promptKey, turnId),
        clearPromptTurn: (threadId, turnId) => acquisition.prompts.clearTurn(threadId, turnId),
        onUserMessageEcho: (clientMessageId, providerIdentity) => {
          // Only a send THIS session admitted; an echo from history restore or
          // another client names no submission of ours to settle.
          if (dispatchEchoes.settle(clientMessageId)) {
            deps.onDispatchSettledLate?.({ sessionId, clientMessageId, providerIdentity })
          }
        }
      })
    : null
  const open = deps.openConnection ?? openCodexAppServerConnection
  try {
    await stopSupersededCodexAcquisition({
      sessionId,
      registry: acquisitions,
      replacement: attempt,
      previous: previousAttempt
    })
    acquisitions.assertCurrent(sessionId, attempt)
    if (!(await closeCodexPublishedSession(sessions, sessionId, deps.onEvent))) {
      throw new Error(`codex app-server for session ${sessionId} could not be stopped`)
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const { launch, externalAuth, attestationExpected } =
      await resolveCodexStructuredLabLaunchHosts({
        identity: acquireInput.identity,
        resolveLaunch: deps.resolveLaunch
      })
    labDynamicToolHost = launch.labDynamicToolHost
    labExternalChatGptAuth = externalAuth
    acquisitions.assertCurrent(sessionId, attempt)
    const upstreamConnection = await open(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: buildCodexStructuredChildEnvironment(launch, acquireInput.spawnToken, sessionId),
        ...(launch.environmentMode ? { environmentMode: launch.environmentMode } : {}),
        ...(launch.executableIntegrity ? { executableIntegrity: launch.executableIntegrity } : {})
      },
      createCodexStructuredSessionConnectionHandlers({
        acquisition,
        sessionId,
        sessions,
        dispatchEchoes,
        notificationRetries,
        externalAuth: labExternalChatGptAuth,
        disposeExternalAuth: disposeExternalAuthHost,
        now: deps.now,
        onEvent: deps.onEvent,
        onBackgroundTasksChanged: deps.onBackgroundTasksChanged,
        deliver: input.deliver,
        handleServerRequest: input.handleServerRequest,
        handleUnhandledFrame: input.handleUnhandledFrame
      })
    )
    acquisition.connection = upstreamConnection
    const externalAuthReceipt = await labExternalChatGptAuth?.authenticate(
      upstreamConnection,
      deps.requestTimeoutMs
    )
    const connection = guardCodexAppServerConnectionForWorkerAccess(
      upstreamConnection,
      launch.workerAccessMode,
      attestationExpected ? { capacityPolicy: attestationExpected.capacityPolicy } : {}
    )
    acquisition.connection = connection
    if (connection.pauseReading && connection.resumeReading) {
      unbindReadingControl = acquireInput.events?.bindReadingControl?.({
        pauseReading: connection.pauseReading,
        resumeReading: () => {
          connection.resumeReading?.()
          notificationRetries.retry(sessionId, connection)
        }
      })
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const opened = await openCodexThread(connection, launch, deps.requestTimeoutMs)
    acquisitions.assertCurrent(sessionId, attempt)
    await attestCodexLabOpenedThread({
      connection,
      expected: attestationExpected,
      externalAuthReceipt: externalAuthReceipt ?? null,
      opened,
      ...(deps.observeLabAuthJson ? { observeAuthJson: deps.observeLabAuthJson } : {}),
      ...(deps.requestTimeoutMs === undefined ? {} : { timeoutMs: deps.requestTimeoutMs })
    })
    acquisitions.assertCurrent(sessionId, attempt)
    primaryThreadId = opened.threadId
    const restoreAdmission = translator?.restoreThread(opened.threadId, opened.thread ?? {})
    if (restoreAdmission && !restoreAdmission.accepted) {
      throw new AgentSessionAcquisitionRefusal(
        'Codex thread history exceeds the bounded restore queue; history was not partially imported.'
      )
    }
    const process = await codexProcessIdentity(
      { ...acquireInput, pid: connection.pid },
      deps.readProcessStartTime
    )
    acquisitions.assertCurrent(sessionId, attempt)
    const acquired: AgentSessionAcquisition = {
      process,
      link: codexProviderHandleLink({
        threadId: opened.threadId,
        resumed: launch.resumeThreadId !== null,
        fence: acquireInput.fence,
        linkId: deps.mintLinkId?.(),
        observedAt: deps.now?.() ?? Date.now()
      }),
      acquisitionGeneration: mintCodexAcquisitionGeneration(deps)
    }
    if (connection.closed) {
      throw new Error(`codex app-server for session ${sessionId} exited while being acquired`)
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const options = restoredCodexSessionOptions(acquireInput.options)
    const fastModeCatalog =
      options.get('fastMode') === 'true' || options.has('serviceTier')
        ? await readCodexStructuredSessionOptionCatalog({
            connection,
            current: {
              ...(opened.model ? { model: opened.model } : {}),
              ...(opened.effort ? { effort: opened.effort } : {}),
              fastMode: true
            },
            timeoutMs: deps.requestTimeoutMs
          }).catch(() => null)
        : null
    acquisitions.assertCurrent(sessionId, attempt)
    if (connection.closed) {
      throw new Error(`codex app-server for session ${sessionId} exited while being acquired`)
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    const session: CodexSession = {
      connection,
      ...codexSessionLifecycle(acquireInput.fence, acquired.acquisitionGeneration as string),
      threadId: opened.threadId,
      historyPath: opened.historyPath,
      historyMode: opened.historyMode,
      activeTurnIds: new Set(),
      ...(launch.workerAccessMode ? { workerAccessMode: launch.workerAccessMode } : {}),
      ...(labDynamicToolHost ? { labDynamicToolHost } : {}),
      prompts: acquisition.prompts,
      options,
      reportedOptions: reportedCodexThreadOptions(opened),
      fastModeTierByModel: fastModeCatalog?.fastModeTierByModel ?? new Map(),
      dispatchEchoes,
      translator,
      backgroundTasks: new CodexBackgroundTaskTracker(opened.threadId, subagentExecutions),
      forceCloseUnexpected: (reason) =>
        input.forceCloseUnexpected(
          sessionId,
          acquireInput.fence,
          acquired.acquisitionGeneration as string,
          reason
        ),
      ...(unbindReadingControl ? { unbindReadingControl } : {})
    }
    if (fastModeCatalog) {
      const model = opened.model ?? fastModeCatalog.result.current.model
      reconcileCodexFastModeOption(session, {
        fastModeTierByModel: fastModeCatalog.fastModeTierByModel,
        currentFastMode: true,
        model,
        modelFastModeSupport: fastModeCatalog.result.models.find((entry) => entry.id === model)
          ?.supportsFastMode
      })
    }
    turnCancellation.register(session)
    sessions.set(sessionId, session)
    labDynamicToolHostPublished = true
    for (const event of acquisition.drain()) {
      event()
    }
    return acquired
  } catch (error) {
    if (sessions.get(sessionId)?.connection !== acquisition.connection) {
      if (!acquisition.connection && !isCodexAppServerHandshakeExitUnprovenError(error)) {
        disposeExternalAuthHost()
      }
      return closeFailedCodexAcquisition({
        sessionId,
        registry: acquisitions,
        attempt,
        cause: error,
        dispose: () => {
          if (!labDynamicToolHostPublished) {
            labDynamicToolHost?.dispose()
            labDynamicToolHost = undefined
          }
          unbindReadingControl?.()
          translator?.dispose()
        }
      })
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw error
  } finally {
    attempt.finish()
  }
}
