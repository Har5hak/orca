import { randomBytes } from 'node:crypto'
import {
  LocalSbxInboxContract,
  LocalSbxReadyContract,
  LocalSbxResultContract,
  LocalSbxTaskContract,
  type LocalSbxResult,
  type LocalSbxTask
} from './local-sbx-contracts'
import {
  assertHealthySbxVersion,
  inspectSbxInventory,
  localSbxPrompt,
  localSbxResultJsonSchema,
  parseCodexLocalSbxResult,
  sandboxNameForDispatch,
  sbxCodexExecArgs,
  sbxCreateArgs,
  sbxInventoryArgs,
  sbxVersionArgs,
  sbxWriteResultSchemaArgs
} from './local-sbx-command-plan'
import type {
  LocalSbxExecutorDependencies,
  LocalSbxExecutorReceipt
} from './local-sbx-executor-types'
import {
  commandFailure,
  commandSucceeded,
  errorText,
  failedReceipt,
  handleLocalSbxCreateFailure,
  recordLocalSbxOutcomeUnknown,
  releaseSettledLocalSbx,
  runLocalSbxCommand
} from './local-sbx-executor-recovery'

export type {
  LocalSbxArgvAdapter,
  LocalSbxCommandResult,
  LocalSbxHostAuthority
} from './local-sbx-executor-types'

export async function runLocalSbxExecutor(
  input: { spec: string },
  dependencies: LocalSbxExecutorDependencies
): Promise<LocalSbxExecutorReceipt> {
  const version = await runLocalSbxCommand(dependencies.sbx, sbxVersionArgs())
  if (!commandSucceeded(version)) {
    return failedReceipt('version', 'not_created', commandFailure(version, 'sbx version failed'))
  }
  try {
    assertHealthySbxVersion(version.stdout)
  } catch (error) {
    return failedReceipt('version', 'not_created', errorText(error))
  }

  const binding = await dependencies.authority.acceptDispatch({
    spec: input.spec,
    executor: 'local-sbx-v1'
  })
  const task = LocalSbxTaskContract.parse({
    version: 'orca.local-sbx.v1',
    ...binding,
    nonce: (dependencies.createNonce ?? defaultNonce)(),
    agent: 'codex'
  })
  const sandboxName = sandboxNameForDispatch(task.dispatchId)
  const create = await runLocalSbxCommand(dependencies.sbx, sbxCreateArgs(sandboxName))
  if (!commandSucceeded(create)) {
    return handleLocalSbxCreateFailure({ dependencies, binding, sandboxName, create })
  }

  const readyInventory = await runLocalSbxCommand(dependencies.sbx, sbxInventoryArgs())
  if (
    !commandSucceeded(readyInventory) ||
    inspectSbxInventory(readyInventory.stdout, {
      name: sandboxName,
      agent: 'codex',
      stopped: false
    }) !== 'live'
  ) {
    return recordLocalSbxOutcomeUnknown({
      dependencies,
      binding,
      sandboxName,
      stage: 'ready_inventory',
      error: commandFailure(readyInventory, 'Sandbox readiness could not be verified.')
    })
  }

  const ready = LocalSbxReadyContract.parse({
    version: 'orca.local-sbx.v1',
    dispatchId: task.dispatchId,
    nonce: task.nonce,
    sandboxName,
    state: 'ready'
  })
  try {
    await dependencies.authority.recordReady(ready)
  } catch (error) {
    return recordLocalSbxOutcomeUnknown({
      dependencies,
      binding,
      sandboxName,
      stage: 'ready_record',
      error: errorText(error)
    })
  }

  let inbox
  try {
    inbox = LocalSbxInboxContract.parse(await dependencies.authority.takeOneDelivery(task))
    requireIdentity(inbox, task)
  } catch (error) {
    return recordLocalSbxOutcomeUnknown({
      dependencies,
      binding,
      sandboxName,
      stage: 'delivery',
      error: errorText(error)
    })
  }

  const schemaWrite = await runLocalSbxCommand(
    dependencies.sbx,
    sbxWriteResultSchemaArgs(sandboxName),
    { input: localSbxResultJsonSchema() }
  )
  if (!commandSucceeded(schemaWrite)) {
    return recordLocalSbxOutcomeUnknown({
      dependencies,
      binding,
      sandboxName,
      stage: 'schema_write',
      error: commandFailure(schemaWrite, 'Result schema upload failed.')
    })
  }

  const execution = await runLocalSbxCommand(dependencies.sbx, sbxCodexExecArgs(sandboxName), {
    input: localSbxPrompt(task, inbox),
    timeoutMs: 30 * 60_000
  })
  if (!commandSucceeded(execution)) {
    return recordLocalSbxOutcomeUnknown({
      dependencies,
      binding,
      sandboxName,
      stage: 'execute',
      error: commandFailure(execution, 'Sandbox agent execution failed.')
    })
  }

  let result: LocalSbxResult
  try {
    result = LocalSbxResultContract.parse(parseCodexLocalSbxResult(execution.stdout))
    requireIdentity(result, task)
    if (result.deliveryId !== inbox.deliveryId) {
      throw new Error('Sandbox result does not echo the outstanding Delivery ID.')
    }
  } catch (error) {
    return recordLocalSbxOutcomeUnknown({
      dependencies,
      binding,
      sandboxName,
      stage: 'result_validation',
      error: errorText(error)
    })
  }

  try {
    await dependencies.authority.settleWorkerDoneAndAcknowledge({ task, result })
  } catch (error) {
    return recordLocalSbxOutcomeUnknown({
      dependencies,
      binding,
      sandboxName,
      stage: 'settlement',
      error: errorText(error)
    })
  }

  const release = await releaseSettledLocalSbx(dependencies, task.dispatchId, sandboxName)
  return {
    state: result.outcome,
    stage: release.stage,
    taskId: task.taskId,
    dispatchId: task.dispatchId,
    sandboxName,
    release: release.release,
    ...(release.error ? { error: release.error } : {})
  }
}

function requireIdentity(
  value: { dispatchId: string; nonce: string; taskId?: string },
  task: LocalSbxTask
): void {
  if (
    value.dispatchId !== task.dispatchId ||
    value.nonce !== task.nonce ||
    (value.taskId !== undefined && value.taskId !== task.taskId)
  ) {
    throw new Error('Sandbox contract identity does not match the active Dispatch.')
  }
}

function defaultNonce(): string {
  return randomBytes(24).toString('base64url')
}
