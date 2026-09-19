import type { CodexLabLaunchReceiptV1 } from '../../../../orchestration/lab-profile/codex-lab-launch-receipt'
import type { WorkerDispatchRow } from '../../../../orchestration/types'
import type { WorkerEffect } from './worker-topology'

type ResultContext = Readonly<{
  runId: string
  taskId: string
  dispatchId: string
  profile: string
  adapter: string
}>

export function readyLocalLabWorkerStartResult(input: {
  context: ResultContext
  worker: WorkerDispatchRow
  workerOutcome: 'succeeded' | 'failed' | undefined
  launchReceipt: CodexLabLaunchReceiptV1
  alreadySettled: boolean
  effects: readonly WorkerEffect[]
}): unknown {
  const { context, worker, workerOutcome } = input
  return {
    ...context,
    state: workerOutcome ? 'ready' : worker.state,
    stage: worker.stage,
    ...(workerOutcome ? { workerOutcome } : {}),
    turnStart: 'observed',
    launchReceipt: input.launchReceipt,
    mode: { requested: 'structured', effective: 'structured' },
    effects: input.alreadySettled
      ? [
          ...parseWorkerJsonArray(worker.effects, 'effects'),
          ...input.effects.filter((effect) => effect.kind === 'dispatch_input')
        ]
      : parseWorkerJsonArray(worker.effects, 'effects'),
    residualResources: parseWorkerJsonArray(worker.residual_resources, 'residual resources')
  }
}

export function settledLocalLabWorkerStartFailureResult(input: {
  context: ResultContext
  worker: WorkerDispatchRow
  workerOutcome: 'succeeded' | 'failed' | undefined
  lastError: string
  cleanupErrors: readonly string[]
  launchReceipt: CodexLabLaunchReceiptV1 | null | undefined
}): unknown {
  const { context, worker, workerOutcome } = input
  return {
    ...context,
    state: workerOutcome ? 'ready' : worker.state,
    stage: worker.stage,
    ...(workerOutcome ? { workerOutcome } : {}),
    lastError: input.lastError,
    ...(input.cleanupErrors.length > 0 ? { cleanupErrors: input.cleanupErrors } : {}),
    ...(input.launchReceipt ? { launchReceipt: input.launchReceipt } : {}),
    mode: { requested: 'structured', effective: 'structured' },
    effects: parseWorkerJsonArray(worker.effects, 'effects'),
    residualResources: parseWorkerJsonArray(worker.residual_resources, 'residual resources')
  }
}

export function failedLocalLabWorkerStartResult(input: {
  context: ResultContext
  worker: WorkerDispatchRow
  failedStage: string
  lastError: string
  cleanupErrors: readonly string[]
  launchReceipt: CodexLabLaunchReceiptV1 | null | undefined
}): unknown {
  return {
    ...input.context,
    state: input.worker.state,
    stage: input.worker.stage,
    failedStage: input.failedStage,
    lastError: input.lastError,
    ...(input.cleanupErrors.length > 0 ? { cleanupErrors: input.cleanupErrors } : {}),
    ...(input.launchReceipt ? { launchReceipt: input.launchReceipt } : {}),
    mode: { requested: 'structured', effective: 'structured' },
    effects: parseWorkerJsonArray(input.worker.effects, 'effects'),
    residualResources: parseWorkerJsonArray(input.worker.residual_resources, 'residual resources')
  }
}

function parseWorkerJsonArray(serialized: string, field: string): unknown[] {
  const value: unknown = JSON.parse(serialized)
  if (!Array.isArray(value)) {
    throw new Error(`Worker ${field} must be a JSON array.`)
  }
  return value
}
