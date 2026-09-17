import type { OrchestrationWorkerLaunchReceipt } from '../worker/worker-launch-preferences'

export const ORCHESTRATION_WORKER_LAUNCH_FIELD_MAX_LENGTH = 512
const ORCHESTRATION_WORKER_RECEIPT_ID_MAX_LENGTH = 4_096
const ORCHESTRATION_WORKER_RECEIPT_TEXT_MAX_LENGTH = 32_768
const ORCHESTRATION_WORKER_RECEIPT_ARRAY_MAX_LENGTH = 512

type RemoteFederatedWorkerStartState = 'ready' | 'failed' | 'outcome_unknown'

export type RemoteFederatedWorkerStartReceipt = {
  dispatchId: string
  state: RemoteFederatedWorkerStartState
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
  if (
    !isRecord(value) ||
    !isStructuredIdentifier(value.dispatchId, ORCHESTRATION_WORKER_RECEIPT_ID_MAX_LENGTH) ||
    !isRemoteFederatedWorkerStartState(value.state)
  ) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  if (
    value.state === 'ready' &&
    (!isStructuredIdentifier(value.runtimeEpoch) ||
      !isStructuredIdentifier(value.worktreeId, ORCHESTRATION_WORKER_RECEIPT_ID_MAX_LENGTH) ||
      !isStructuredIdentifier(value.terminalHandle))
  ) {
    throw new Error('The worker server returned an invalid ready receipt.')
  }
  const runtimeEpoch = parseOptionalStructuredIdentifier(value.runtimeEpoch)
  const worktreeId = parseOptionalStructuredIdentifier(
    value.worktreeId,
    ORCHESTRATION_WORKER_RECEIPT_ID_MAX_LENGTH
  )
  const terminalHandle = parseOptionalStructuredIdentifier(value.terminalHandle)
  const setup = parseOptionalSetupReceipt(value.setup)
  const effects = parseOptionalReceiptArray(value.effects)
  const residualResources = parseOptionalReceiptArray(value.residualResources)
  const failedStage = parseOptionalBoundedText(
    value.failedStage,
    ORCHESTRATION_WORKER_LAUNCH_FIELD_MAX_LENGTH
  )
  const lastError = parseOptionalBoundedText(
    value.lastError,
    ORCHESTRATION_WORKER_RECEIPT_TEXT_MAX_LENGTH
  )
  let launch: OrchestrationWorkerLaunchReceipt | undefined
  if (value.launch !== undefined) {
    launch = parseWorkerLaunchReceipt(value.launch)
  }
  return {
    ...value,
    dispatchId: value.dispatchId,
    state: value.state,
    ...(runtimeEpoch !== undefined ? { runtimeEpoch } : {}),
    ...(worktreeId !== undefined ? { worktreeId } : {}),
    ...(terminalHandle !== undefined ? { terminalHandle } : {}),
    ...(setup !== undefined ? { setup } : {}),
    ...(launch !== undefined ? { launch } : {}),
    ...(effects !== undefined ? { effects } : {}),
    ...(residualResources !== undefined ? { residualResources } : {}),
    ...(failedStage !== undefined ? { failedStage } : {}),
    ...(lastError !== undefined ? { lastError } : {})
  }
}

export function isReadyRemoteFederatedWorkerStartReceipt(
  receipt: RemoteFederatedWorkerStartReceipt
): receipt is ReadyRemoteFederatedWorkerStartReceipt {
  return receipt.state === 'ready'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRemoteFederatedWorkerStartState(
  value: unknown
): value is RemoteFederatedWorkerStartState {
  return value === 'ready' || value === 'failed' || value === 'outcome_unknown'
}

function parseNullableLaunchField(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > ORCHESTRATION_WORKER_LAUNCH_FIELD_MAX_LENGTH ||
    value.trim() !== value
  ) {
    return undefined
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isForbiddenLaunchFieldCodePoint(codePoint)) {
      return undefined
    }
  }
  return value
}

function parseWorkerLaunchSelection(value: unknown) {
  if (!isRecord(value)) {
    return null
  }
  const agent = parseNullableLaunchField(value.agent)
  const model = parseNullableLaunchField(value.model)
  const effort = parseNullableLaunchField(value.effort)
  if (agent === undefined || model === undefined || effort === undefined) {
    return null
  }
  return { ...value, agent, model, effort }
}

function parseWorkerLaunchReceipt(value: unknown): OrchestrationWorkerLaunchReceipt {
  if (!isRecord(value)) {
    throw new Error('The worker server returned an invalid launch receipt.')
  }
  const requested = parseWorkerLaunchSelection(value.requested)
  const effective = value.effective === null ? null : parseWorkerLaunchSelection(value.effective)
  if (!requested || (value.effective !== null && !effective)) {
    throw new Error('The worker server returned an invalid launch receipt.')
  }
  return { ...value, requested, effective }
}

function isForbiddenLaunchFieldCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0x061c ||
    codePoint === 0x200b ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  )
}

function isStructuredIdentifier(
  value: unknown,
  maxLength = ORCHESTRATION_WORKER_LAUNCH_FIELD_MAX_LENGTH
): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    return false
  }
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return !isForbiddenLaunchFieldCodePoint(codePoint)
  })
}

function parseOptionalStructuredIdentifier(
  value: unknown,
  maxLength = ORCHESTRATION_WORKER_LAUNCH_FIELD_MAX_LENGTH
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isStructuredIdentifier(value, maxLength)) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  return value
}

function parseOptionalBoundedText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint >= 0xd800 && codePoint <= 0xdfff
    })
  ) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  return value
}

function parseOptionalReceiptArray(value: unknown): unknown[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > ORCHESTRATION_WORKER_RECEIPT_ARRAY_MAX_LENGTH) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  return value
}

function parseOptionalSetupReceipt(value: unknown): { state: string } | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value) || !isStructuredIdentifier(value.state)) {
    throw new Error('The worker server returned an invalid attachment receipt.')
  }
  return { ...value, state: value.state }
}
