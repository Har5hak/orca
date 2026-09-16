import { isTuiAgent } from '../../../../../../shared/tui-agent-config'
import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'

export type RemoteFederatedWorkerStartReceipt = {
  dispatchId: string
  state: string
  runtimeEpoch?: string
  worktreeId?: string
  terminalHandle?: string
  setup?: { state: string }
  launch?: OrchestrationWorkerLaunchReceipt
  effects?: unknown[]
  residualResources?: unknown[]
  failedStage?: string
  lastError?: string
}

export type ReadyRemoteFederatedWorkerStartReceipt = RemoteFederatedWorkerStartReceipt & {
  state: 'ready'
  runtimeEpoch: string
  worktreeId: string
  terminalHandle: string
}

export function parseRemoteFederatedWorkerStartReceipt(
  value: unknown
): RemoteFederatedWorkerStartReceipt {
  if (!isRecord(value) || !isNonEmptyString(value.dispatchId) || !isNonEmptyString(value.state)) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  if (
    value.state === 'ready' &&
    (!isNonEmptyString(value.runtimeEpoch) ||
      !isNonEmptyString(value.worktreeId) ||
      !isNonEmptyString(value.terminalHandle))
  ) {
    throw new Error('The worker server returned an invalid ready receipt.')
  }
  if (value.launch !== undefined && !isWorkerLaunchReceipt(value.launch)) {
    throw new Error('The worker server returned an invalid launch receipt.')
  }
  return value as RemoteFederatedWorkerStartReceipt
}

export function isReadyRemoteFederatedWorkerStartReceipt(
  receipt: RemoteFederatedWorkerStartReceipt
): receipt is ReadyRemoteFederatedWorkerStartReceipt {
  return receipt.state === 'ready'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value)
}

function isNullableTuiAgent(value: unknown): boolean {
  return value === null || isTuiAgent(value)
}

function isWorkerLaunchSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNullableTuiAgent(value.agent) &&
    isNullableNonEmptyString(value.model) &&
    isNullableNonEmptyString(value.effort)
  )
}

function isWorkerLaunchReceipt(value: unknown): boolean {
  return (
    isRecord(value) &&
    isWorkerLaunchSelection(value.requested) &&
    (value.effective === null || isWorkerLaunchSelection(value.effective))
  )
}
