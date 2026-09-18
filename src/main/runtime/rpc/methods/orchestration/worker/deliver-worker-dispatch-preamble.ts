import type { RuntimeTerminalSend } from '../../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { buildLabDispatchPreamble } from '../../../../orchestration/lab-profile/lab-dispatch-preamble'
import { getCodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import { sendStructuredWorkerPreamble } from '../../orchestration-structured-worker-session'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

type StructuredSession = Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
type ActiveStructuredSession = Exclude<StructuredSession, null>

export const LAB_DISPATCH_PREAMBLE_DELIVERY_REFUSAL_CODE =
  'ORCA_CODEX_LAB_PREAMBLE_DELIVERY_REFUSED' as const

export class LabDispatchPreambleDeliveryRefusal extends Error {
  readonly code = LAB_DISPATCH_PREAMBLE_DELIVERY_REFUSAL_CODE

  constructor(
    readonly reason:
      | 'delivery_mode_invalid'
      | 'forbidden_authority_input'
      | 'lab_binding_delivery_mismatch'
      | 'lab_binding_dispatch_mismatch'
      | 'lab_binding_missing'
      | 'structured_session_invalid'
      | 'structured_session_required'
  ) {
    super(`Codex laboratory dispatch preamble delivery refused: ${reason}`)
    this.name = 'LabDispatchPreambleDeliveryRefusal'
  }
}

type LabDispatchPreambleDelivery = Readonly<{
  delivery: 'lab-structured-only'
  structuredSession: ActiveStructuredSession
  dispatchId: string
  taskSpec: string
}>

type OrdinaryDispatchPreambleDelivery = Readonly<{
  delivery: 'ordinary'
  runtime: OrcaRuntimeService
  structuredSession: StructuredSession
  terminalHandle: string
  dispatchId: string
  dispatchDepth: number
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  dispatchCapability: string
  devMode: boolean | undefined
  requestId: string
}>

const LAB_DELIVERY_FIELDS = Object.freeze([
  'delivery',
  'structuredSession',
  'dispatchId',
  'taskSpec'
] as const)

/**
 * Hands a started worker the preamble allowed by its explicit delivery mode.
 *
 * Ordinary workers retain the full lifecycle preamble. A Codex laboratory worker receives only
 * its restricted dynamic-tool contract, and that contract can travel only through the structured
 * session — there is deliberately no terminal fallback.
 */
export async function deliverWorkerDispatchPreamble(
  args: LabDispatchPreambleDelivery | OrdinaryDispatchPreambleDelivery
): Promise<RuntimeTerminalSend['prompt']> {
  const delivery = args.delivery
  if (delivery !== 'lab-structured-only' && delivery !== 'ordinary') {
    throw new LabDispatchPreambleDeliveryRefusal('delivery_mode_invalid')
  }
  if (delivery === 'lab-structured-only') {
    const structuredSession = args.structuredSession
    const session = snapshotStructuredSession(structuredSession)
    if (!structuredSession) {
      throw new LabDispatchPreambleDeliveryRefusal('structured_session_required')
    }
    if (!session) {
      throw new LabDispatchPreambleDeliveryRefusal('structured_session_invalid')
    }
    if (
      LAB_DELIVERY_FIELDS.some((field) => !Object.hasOwn(args, field)) ||
      Reflect.ownKeys(args).some(
        (field) =>
          typeof field !== 'string' ||
          !LAB_DELIVERY_FIELDS.some((allowedField) => allowedField === field)
      )
    ) {
      throw new LabDispatchPreambleDeliveryRefusal('forbidden_authority_input')
    }
    const dispatchId = args.dispatchId
    const taskSpec = args.taskSpec
    const binding = getCodexLabStructuredLaunchBinding(session.sessionId)
    if (!binding) {
      throw new LabDispatchPreambleDeliveryRefusal('lab_binding_missing')
    }
    if (binding.dispatchId !== dispatchId) {
      throw new LabDispatchPreambleDeliveryRefusal('lab_binding_dispatch_mismatch')
    }
    await sendStructuredWorkerPreamble({
      host: session.host,
      sessionId: session.sessionId,
      dispatchId,
      preamble: buildLabDispatchPreamble({ taskSpec })
    })
    return undefined
  }
  const {
    runtime,
    structuredSession,
    terminalHandle,
    dispatchId,
    dispatchDepth,
    taskId,
    taskSpec,
    coordinatorHandle,
    dispatchCapability,
    devMode,
    requestId
  } = args
  const session = snapshotStructuredSession(structuredSession)
  if (structuredSession && !session) {
    throw new LabDispatchPreambleDeliveryRefusal('structured_session_invalid')
  }
  if (session && getCodexLabStructuredLaunchBinding(session.sessionId)) {
    throw new LabDispatchPreambleDeliveryRefusal('lab_binding_delivery_mismatch')
  }
  const preamble = buildDispatchPreamble({
    // Depth only. A worker is taught the same verbs whichever mode it runs in, so this must not
    // become a second gate: resolving the caller's worktree is what lets a structured worker
    // dispatch sub-workers exactly like a PTY one.
    canDispatchSubWorkers: dispatchDepth < runtime.getNestedWorkerMaxDepth(),
    taskId,
    dispatchId,
    taskSpec,
    coordinatorHandle,
    workerHandle: terminalHandle,
    dispatchCapability,
    devMode,
    cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
  })
  if (session) {
    await sendStructuredWorkerPreamble({
      host: session.host,
      sessionId: session.sessionId,
      dispatchId,
      preamble
    })
    return undefined
  }
  return (
    await runtime.sendTerminalAgentPrompt(terminalHandle, preamble, {
      acceptQueued: true,
      observationTimeoutMs: 0,
      requestId
    })
  ).prompt
}

function snapshotStructuredSession(
  session: StructuredSession
): Readonly<{ host: ActiveStructuredSession['host']; sessionId: string }> | null {
  if (!session) {
    return null
  }
  try {
    const sessionId = session.identity.sessionId
    const host = session.host
    return typeof sessionId === 'string' && sessionId.trim() ? { host, sessionId } : null
  } catch {
    return null
  }
}
