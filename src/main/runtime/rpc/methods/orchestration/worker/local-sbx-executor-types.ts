import type { LocalSbxReady, LocalSbxResult, LocalSbxTask } from './local-sbx-contracts'

export type LocalSbxCommandResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputTruncated?: boolean
}

export type LocalSbxArgvAdapter = {
  run: (
    args: readonly string[],
    options?: { input?: string; timeoutMs?: number }
  ) => Promise<LocalSbxCommandResult>
}

export type LocalSbxDispatchBinding = {
  runId: string
  taskId: string
  dispatchId: string
  spec: string
}

export type LocalSbxHostAuthority = {
  acceptDispatch: (input: {
    spec: string
    executor: 'local-sbx-v1'
  }) => Promise<LocalSbxDispatchBinding>
  recordReady: (ready: LocalSbxReady) => Promise<void>
  takeOneDelivery: (task: LocalSbxTask) => Promise<unknown>
  settleWorkerDoneAndAcknowledge: (input: {
    task: LocalSbxTask
    result: LocalSbxResult
  }) => Promise<void>
  failDispatch: (input: {
    binding: LocalSbxDispatchBinding
    stage: LocalSbxStage
    error: string
  }) => Promise<void>
  recordOutcomeUnknown: (input: {
    binding: LocalSbxDispatchBinding
    stage: LocalSbxStage
    error: string
  }) => Promise<void>
  closeRunnerTerminal: (dispatchId: string) => Promise<void>
}

export type LocalSbxStage =
  | 'version'
  | 'create'
  | 'ready_inventory'
  | 'ready_record'
  | 'delivery'
  | 'schema_write'
  | 'execute'
  | 'result_validation'
  | 'settlement'
  | 'stop'
  | 'stopped_inventory'
  | 'runner_close'

export type LocalSbxExecutorReceipt = {
  state: 'succeeded' | 'failed' | 'outcome_unknown'
  stage: LocalSbxStage
  taskId?: string
  dispatchId?: string
  sandboxName?: string
  release: 'not_created' | 'released' | 'release_unknown' | 'retained'
  error?: string
}

export type LocalSbxExecutorDependencies = {
  sbx: LocalSbxArgvAdapter
  authority: LocalSbxHostAuthority
  createNonce?: () => string
}
