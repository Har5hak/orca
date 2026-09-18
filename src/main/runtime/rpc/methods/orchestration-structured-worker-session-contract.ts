import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  CodexLabStructuredBindingRefusal,
  type CodexLabStructuredLaunchBinding
} from '../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'

export type CodexLabStructuredWorkerBeforeAttachResult = Readonly<{
  labLaunchBinding: CodexLabStructuredLaunchBinding
}>

/** Ordinary preparation cannot select laboratory mode. */
export type StructuredWorkerBeforeAttach = (
  identity: Readonly<StructuredWorkerIdentity>
) => Promise<void>

/** Explicit laboratory preparation must return the binding consumed by its sole attach. */
export type CodexLabStructuredWorkerBeforeAttach = (
  identity: Readonly<StructuredWorkerIdentity>
) => Promise<CodexLabStructuredWorkerBeforeAttachResult>

export function isCodexLabBeforeAttachResult(
  value: unknown
): value is CodexLabStructuredWorkerBeforeAttachResult {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'labLaunchBinding')) {
    return false
  }
  const binding = Reflect.get(value, 'labLaunchBinding')
  return typeof binding === 'object' && binding !== null
}

type CommonArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  worktreeId: string
  dispatchId: string
  options?: Readonly<Record<string, string>>
  onJournalActivity: (sessionId: string) => void
}

export type CreateStructuredWorkerSessionArgs = CommonArgs &
  (
    | {
        agent: 'claude' | 'codex'
        launchMode?: 'ordinary'
        beforeAttach?: StructuredWorkerBeforeAttach
      }
    | {
        agent: 'codex'
        launchMode: 'codex-lab'
        beforeAttach: CodexLabStructuredWorkerBeforeAttach
      }
  )

export function assertStructuredWorkerLaunchMode(
  value: unknown
): asserts value is 'ordinary' | 'codex-lab' | undefined {
  if (value !== undefined && value !== 'ordinary' && value !== 'codex-lab') {
    throw new OrchestrationError(
      'worker_launch_mode_invalid',
      'Structured worker launchMode must be ordinary or codex-lab.'
    )
  }
}

export function assertStructuredWorkerAgentMode(agent: unknown, launchMode: unknown): void {
  if (launchMode === 'codex-lab' && agent !== 'codex') {
    throw new CodexLabStructuredBindingRefusal('agent_mode_mismatch')
  }
}

export function assertStructuredWorkerDispatchStarting(
  db: OrchestrationDb,
  dispatchId: string
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  if (!dispatch || dispatch.status !== 'pending' || !worker || worker.state !== 'starting') {
    throw new OrchestrationError('dispatch_inactive', `Dispatch ${dispatchId} is not starting.`)
  }
}

export function assertStructuredWorkerStartRequest(args: {
  db: OrchestrationDb
  dispatchId: string
  agent: unknown
  launchMode?: unknown
}): void {
  assertStructuredWorkerLaunchMode(args.launchMode)
  assertStructuredWorkerAgentMode(args.agent, args.launchMode)
  assertStructuredWorkerDispatchStarting(args.db, args.dispatchId)
}

export type PendingStructuredWorkerStart = { settled: boolean }

const pendingStartsByDispatchId = new Map<string, PendingStructuredWorkerStart>()

export function reserveStructuredWorkerStart(
  dispatchId: string,
  liveSessionExists: boolean
): PendingStructuredWorkerStart {
  if (liveSessionExists || pendingStartsByDispatchId.has(dispatchId)) {
    throw new OrchestrationError(
      'worker_start_conflict',
      `Structured worker ${dispatchId} already has a start or live session.`
    )
  }
  const pendingStart = { settled: false }
  pendingStartsByDispatchId.set(dispatchId, pendingStart)
  return pendingStart
}

export function markPendingStructuredWorkerStartSettled(dispatchId: string): void {
  const pendingStart = pendingStartsByDispatchId.get(dispatchId)
  if (pendingStart) {
    pendingStart.settled = true
  }
}

export function assertStructuredWorkerStartNotSettled(
  dispatchId: string,
  pendingStart: PendingStructuredWorkerStart
): void {
  if (pendingStart.settled) {
    throw new OrchestrationError(
      'dispatch_settled',
      `Structured worker ${dispatchId} settled while its session was being created.`
    )
  }
}

export function finishStructuredWorkerStart(
  dispatchId: string,
  pendingStart: PendingStructuredWorkerStart
): void {
  if (pendingStartsByDispatchId.get(dispatchId) === pendingStart) {
    pendingStartsByDispatchId.delete(dispatchId)
  }
}

export function releaseFailedStructuredWorkerHold(
  host: StructuredAgentSessionHost | undefined,
  sessionId: string,
  holderId: string | undefined,
  dispatchId: string
): void {
  if (!host || !holderId) {
    return
  }
  try {
    host.release(sessionId, holderId)
  } catch (error) {
    console.warn('[orchestration] failed worker start hold release failed', dispatchId, error)
  }
}
