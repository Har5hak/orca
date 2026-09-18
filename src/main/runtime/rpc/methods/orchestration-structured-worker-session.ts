/**
 * Starting, holding and retiring a worker that IS a structured agent session.
 *
 * Three things make this different from the PTY worker path, and all three live here:
 *
 * - The session is created directly as structured, so readiness is the attach returning ok. There
 *   is no boot-to-idle gap to wait on and no `tui-idle` edge to read.
 * - A structured session's provider child is evicted 15s after its last HOLDER leaves, and holds
 *   come only from bound surfaces. A dispatched worker parked on mail is exactly that state, so
 *   the dispatch takes its own resume-capable hold and keeps it until the worker settles.
 * - The dispatch preamble is a turn, not keystrokes.
 */

import { isDefinitiveAgentSessionCreateRefusal } from '../../../../shared/agent-session-definitive-refusal'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  mintAgentSessionOperationId,
  structuredPointerPayloadFingerprint
} from '../../orchestration/structured-pointer-operation-id'
import { structuredPointerCallerKey } from '../../orchestration/structured-mailbox-pointer-host'
import { retireSettledStructuredWorkerTab } from '../../structured-agent-session-tab-retirement'
import {
  CodexLabStructuredBindingRefusal,
  type CodexLabStructuredLaunchBinding
} from '../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import {
  registerCodexLabStructuredLaunchBinding,
  releaseCodexLabStructuredLaunchBinding
} from '../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry-internal'
import {
  mintStructuredWorkerHandle,
  structuredWorkerHostScope,
  structuredWorkerIdentities,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation,
  type StructuredWorkerIdentity
} from '../../structured-worker-identity'
import { createKeyedTrailingEdgeCoalescer } from '../../keyed-trailing-edge-coalescer'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'
import { mintStructuredWorkerSessionId } from './structured-worker-session-id'
import {
  assertStructuredWorkerStartRequest,
  assertStructuredWorkerStartNotSettled,
  finishStructuredWorkerStart,
  isCodexLabBeforeAttachResult,
  markPendingStructuredWorkerStartSettled,
  releaseFailedStructuredWorkerHold,
  reserveStructuredWorkerStart,
  type CreateStructuredWorkerSessionArgs
} from './orchestration-structured-worker-session-contract'

type StructuredWorkerBinding = {
  sessionId: string
  handle: string
  holderId: string
  disposeSubscription: () => void
}

const bindingsByDispatchId = new Map<string, StructuredWorkerBinding>()

export function structuredWorkerHoldId(dispatchId: string): string {
  return `orchestration:dispatch:${dispatchId}`
}

/**
 * Drops the dispatch's hold, its redrive subscription and its parked mail; the release clock takes
 * it from here.
 *
 * EVERY settlement has to reach this — stop, release AND abandon. A surviving hold does not just
 * leak: it keeps the provider child un-evictable for the life of the app, and makes host crash
 * recovery respawn a child for a worker that was settled long ago.
 */
export function releaseStructuredWorkerSession(
  dispatchId: string,
  runtime?: Pick<OrcaRuntimeService, 'forgetStructuredSessionMail'>
): void {
  markPendingStructuredWorkerStartSettled(dispatchId)
  const binding = bindingsByDispatchId.get(dispatchId)
  if (!binding) {
    return
  }
  bindingsByDispatchId.delete(dispatchId)
  binding.disposeSubscription()
  structuredWorkerIdentities.forget(binding.handle)
  runtime?.forgetStructuredSessionMail?.(binding.sessionId)
  try {
    getStructuredAgentSessionHost()?.release(binding.sessionId, binding.holderId)
  } catch (error) {
    console.warn('[orchestration] structured worker hold release failed', dispatchId, error)
  } finally {
    releaseCodexLabStructuredLaunchBinding(binding.sessionId, dispatchId)
  }
}

export async function createStructuredWorkerSession(
  args: CreateStructuredWorkerSessionArgs
): Promise<{ identity: StructuredWorkerIdentity; host: StructuredAgentSessionHost }> {
  // Fail closed for stale JavaScript callers too: a lab binding is accepted only as the result of
  // the post-registration callback below, never as pre-identity input.
  if (Object.hasOwn(args, 'labLaunchBinding')) {
    throw new CodexLabStructuredBindingRefusal('binding_invalid')
  }
  assertStructuredWorkerStartRequest(args)
  const sessionId = mintStructuredWorkerSessionId()
  const pendingStart = reserveStructuredWorkerStart(
    args.dispatchId,
    bindingsByDispatchId.has(args.dispatchId)
  )
  // Registered BEFORE the session is created, because `attach` is what spawns the provider child
  // and the child's environment is read from this registry at spawn time. Registering afterwards
  // ships a worker with no ORCA_TERMINAL_HANDLE, whose bare `orca orchestration check` then
  // resolves to whatever single leaf sits in the worktree — by default the COORDINATOR's pane.
  //
  // The scope is provisionally local; the record's own location is asserted local below, and a
  // session that resolves anywhere else never reaches a hold.
  let identity: StructuredWorkerIdentity | undefined
  let created: Awaited<ReturnType<typeof createStructuredAgentSessionForWorktree>> | undefined
  let attachAttempted = false
  let heldHost: StructuredAgentSessionHost | undefined
  let holderId: string | undefined
  let disposeSubscription: (() => void) | undefined
  try {
    identity = structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId,
      agent: args.agent,
      paneKey: mintStructuredWorkerPaneKey(sessionId),
      processIncarnation: structuredWorkerProcessIncarnation(sessionId),
      worktreeId: args.worktreeId,
      hostScope: { kind: 'local', hostId: 'local' }
    })
    let labLaunchBinding: CodexLabStructuredLaunchBinding | undefined
    if (args.launchMode === 'codex-lab') {
      const result = args.beforeAttach ? await args.beforeAttach(identity) : undefined
      if (!isCodexLabBeforeAttachResult(result)) {
        throw new CodexLabStructuredBindingRefusal('binding_missing')
      }
      labLaunchBinding = result.labLaunchBinding
    } else {
      const result: unknown = args.beforeAttach ? await args.beforeAttach(identity) : undefined
      if (isCodexLabBeforeAttachResult(result)) {
        throw new CodexLabStructuredBindingRefusal('binding_invalid')
      }
    }
    assertStructuredWorkerStartNotSettled(args.dispatchId, pendingStart)
    if (
      labLaunchBinding &&
      (args.agent !== 'codex' || labLaunchBinding.dispatchId !== args.dispatchId)
    ) {
      throw new CodexLabStructuredBindingRefusal('binding_invalid')
    }
    if (labLaunchBinding) {
      registerCodexLabStructuredLaunchBinding(sessionId, labLaunchBinding)
    }
    attachAttempted = true
    created = await createStructuredAgentSessionForWorktree({
      runtime: args.runtime,
      ensureHost: async () => {
        await args.runtime.ensureStructuredAgentSessionHost()
        return requireInstalledHost()
      },
      caller: { callerKey: structuredPointerCallerKey(args.dispatchId) },
      envelope: {
        sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: null,
        // Empty on purpose: `prepare` overwrites this with the host's own attach fingerprint, and
        // the create-intent conflict check it would otherwise feed guards the RPC boundary against
        // a replayed operation id — there is no such boundary on this in-process call.
        payloadFingerprint: ''
      },
      worktree: `id:${args.worktreeId}`,
      agent: args.agent,
      // Absent, the host seeds the user's saved selection — the same fallback a chat gets.
      ...(args.options ? { options: args.options } : {}),
      ...(labLaunchBinding
        ? { accountHomePathOverride: labLaunchBinding.plan.runtimePaths.codexHome }
        : {}),
      // Dispatching a worker is background work; it must not pull the surface away from the user.
      activate: false
    })
    assertStructuredWorkerStartNotSettled(args.dispatchId, pendingStart)
    if (!created.ok) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `The structured ${args.agent} session for this worker was refused: ${created.refusal.message}`
      )
    }
    const host = requireInstalledHost()
    const record = host.deps.store.getRecord(sessionId)
    if (!record || !structuredWorkerHostScope(record.location)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        'A structured worker must run on the local execution host outside WSL.'
      )
    }
    holderId = structuredWorkerHoldId(args.dispatchId)
    await host.hold(sessionId, holderId)
    heldHost = host
    assertStructuredWorkerStartNotSettled(args.dispatchId, pendingStart)
    disposeSubscription = subscribeForRedrive(host, sessionId, args.onJournalActivity)
    bindingsByDispatchId.set(args.dispatchId, {
      sessionId,
      handle: identity.handle,
      holderId,
      disposeSubscription
    })
    return { identity, host }
  } catch (error) {
    // A start that fails after the session exists would otherwise strand a live provider child
    // that no dispatch owns and that nothing else in the runtime will ever retire.
    disposeSubscription?.()
    if (identity) {
      structuredWorkerIdentities.forget(identity.handle)
    }
    releaseFailedStructuredWorkerHold(heldHost, sessionId, holderId, args.dispatchId)
    releaseCodexLabStructuredLaunchBinding(sessionId, args.dispatchId)
    if (attachAttempted && structuredCreateMayHaveCommitted(created)) {
      await discardStructuredWorkerSession(sessionId, args.runtime)
    }
    throw error
  } finally {
    finishStructuredWorkerStart(args.dispatchId, pendingStart)
  }
}

/**
 * Whether a create may have attached a session, which is the question cleanup has to ask.
 *
 * `ok` is not the test. `commit` answers `agent_session_operation_unknown` when `attach` SUCCEEDED
 * and only the tab publish failed, and a throw out of the commit half is past `attach` too — the
 * pre-commit half never throws, it refuses. Both leave a live provider child that took no hold and
 * has no binding, so nothing else in the runtime will ever retire it. Only a DEFINITIVE refusal
 * proves there is nothing to discard; everything else gets the best-effort close.
 */
function structuredCreateMayHaveCommitted(
  created: Awaited<ReturnType<typeof createStructuredAgentSessionForWorktree>> | undefined
): boolean {
  return !created || created.ok || !isDefinitiveAgentSessionCreateRefusal(created.refusal.code)
}

/**
 * Best-effort teardown of a session created by a worker start that then failed.
 *
 * Stops the provider child, drops the DURABLE tab reference so nothing restores the chat after a
 * restart, and — only once the close came back without throwing — retires the background tab this
 * start published from the live snapshot. All three are no-ops for a session that was never
 * attached, which is why a non-definitive refusal can reach here unconditionally. A close that
 * threw leaves the tab alone: the child may still be running, and the tab is the way to reach it.
 *
 * Exported because a start can also fail AFTER `createStructuredWorkerSession` returned — on the
 * authority gate, or on the preamble turn — and that is the fourth settlement path. Dropping only
 * the hold there left one dead "Claude Chat"/"Codex Chat" tab per failed start, durably restored
 * on every subsequent app launch.
 */
export async function discardStructuredWorkerSession(
  sessionId: string,
  runtime: Pick<OrcaRuntimeService, 'retireStructuredAgentSessionTabFromSnapshot'>
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  try {
    await host.setSessionTabVisibility?.(sessionId, false)
    await host.close(sessionId)
  } catch (error) {
    console.warn(
      '[orchestration] failed to discard a half-started structured worker',
      sessionId,
      error
    )
    return
  }
  retireSettledStructuredWorkerTab(sessionId, runtime)
}

/** Delivers the dispatch preamble as the worker's first turn. */
type StructuredWorkerPreambleSubmission = Readonly<{
  dispatchState: 'pending' | 'accepted' | 'rejected' | 'unknown'
  reason: string | null
}>

type StructuredWorkerPreambleHost = Readonly<{
  deps: Readonly<{
    store: Readonly<{
      getRecord: (sessionId: string) => Readonly<{ lease: { runtimeFence: number } }> | null
    }>
  }>
  send: (...args: Parameters<StructuredAgentSessionHost['send']>) => Promise<
    | Readonly<{
        ok: true
        value: Readonly<{
          clientMessageId: string
          submission: StructuredWorkerPreambleSubmission
        }>
      }>
    | Readonly<{ ok: false; refusal: Readonly<{ message: string }> }>
  >
  waitForSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<
    Readonly<{ value: Readonly<{ submission: StructuredWorkerPreambleSubmission }> }> | undefined
  >
}>

export async function sendStructuredWorkerPreamble(args: {
  host: StructuredWorkerPreambleHost
  sessionId: string
  dispatchId: string
  preamble: string
}): Promise<void> {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: args.preamble }]
  }
  const fence = args.host.deps.store.getRecord(args.sessionId)?.lease.runtimeFence
  if (fence === undefined) {
    throw new Error('The structured worker session has no durable record to dispatch into.')
  }
  const result = await args.host.send(
    { callerKey: structuredPointerCallerKey(args.dispatchId) },
    {
      envelope: {
        sessionId: args.sessionId,
        clientOperationId: mintAgentSessionOperationId(Date.now()),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredPointerPayloadFingerprint(args.sessionId, body)
      },
      body
    }
  )
  if (!result.ok) {
    throw new Error(`The dispatch preamble was refused: ${result.refusal.message}`)
  }
  const submitted = result.value.submission
  const submission =
    submitted.dispatchState === 'pending'
      ? ((await args.host.waitForSendSettlement(args.sessionId, result.value.clientMessageId))
          ?.value.submission ?? submitted)
      : submitted
  if (submission.dispatchState === 'accepted') {
    return
  }
  if (submission.dispatchState === 'rejected') {
    // A rejection is a verdict, not a mystery: the preamble provably did not happen.
    // `dispatch_preamble_undelivered` says exactly that, and says it as a code rather
    // than as prose, so a coordinator can tell "we could not send it" apart from
    // `operation_unknown`'s "it may be running and you must go look". Both discard the
    // pending receipt; only this one lets the caller retry knowing nothing landed.
    throw new OrchestrationError(
      'dispatch_preamble_undelivered',
      `The dispatch preamble was not delivered: ${submission.reason ?? 'no reason given'}.`
    )
  }
  // Only `accepted` is an acknowledgement — the same rule the mail lane already applies. A thrown
  // adapter call settles as `unknown`, which is indistinguishable from a lost reply, so the start
  // may claim neither delivery nor failure: `operation_unknown` is what turns this into the
  // `outcome_unknown` receipt whose nextCommands send the coordinator to look.
  throw new OrchestrationError(
    'operation_unknown',
    `The dispatch preamble was submitted but not acknowledged (${submission.dispatchState}): ${submission.reason ?? 'no reason given'}.`
  )
}

function requireInstalledHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'Structured agent sessions are unavailable on this runtime.'
    )
  }
  return host
}

/**
 * Quiet window before a coalesced redrive runs. A settled turn stops emitting, so this is how long
 * after the last batch the nudge lands — short enough to read as immediate, long enough that a
 * streaming turn collapses into a handful of evaluations instead of one per batch.
 */
const REDRIVE_FLUSH_MS = 300

/** A turn that streams without pause still gets re-evaluated this often. */
const REDRIVE_MAX_WAIT_MS = 2_000

/**
 * Any journal movement is the redrive edge, coalesced.
 *
 * A settled turn is TOMBSTONED rather than rewritten, so watching for a completed lifecycle row
 * would miss the common case — every batch has to be a candidate. Running the gate on each one is
 * not free once mail IS parked on the session: the edge re-resolves the dispatch, queries unread
 * mail and reads the host's gate facts, only to re-park because the turn is still running. A
 * streaming turn paid that per batch.
 *
 * Coalescing costs nothing in delivery terms. The pointer body names only HOW MANY messages are
 * waiting, so the edge is inherently batch-shaped, and this is not the path fresh mail takes to an
 * idle worker — that is `deliverForHandle`, called when the message is enqueued and untouched
 * here. This is only the retry for mail already parked because the worker was busy.
 */
function subscribeForRedrive(
  host: StructuredAgentSessionHost,
  sessionId: string,
  onJournalActivity: (sessionId: string) => void
): () => void {
  const coalescer = createKeyedTrailingEdgeCoalescer(onJournalActivity, {
    flushMs: REDRIVE_FLUSH_MS,
    maxWaitMs: REDRIVE_MAX_WAIT_MS
  })
  try {
    const unsubscribe = host.subscribe({
      id: `orchestration:redrive:${sessionId}`,
      sessionId,
      emit: (event) => {
        if (event.type === 'batch' || event.type === 'reset') {
          coalescer.schedule(sessionId)
        }
      }
    })
    // Disposal drops the pending timer rather than flushing it: every settlement reaches here, and
    // a redrive that fires after the hold is gone would nudge a session no dispatch owns.
    return () => {
      coalescer.dispose()
      unsubscribe()
    }
  } catch (error) {
    console.warn('[orchestration] structured worker redrive subscription failed', sessionId, error)
    coalescer.dispose()
    return () => {}
  }
}
