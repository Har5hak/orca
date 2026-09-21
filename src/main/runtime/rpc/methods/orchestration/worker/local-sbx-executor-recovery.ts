import {
  inspectSbxInventory,
  sbxInventoryArgs,
  sbxStopArgs
} from './local-sbx-command-plan'
import type {
  LocalSbxArgvAdapter,
  LocalSbxCommandResult,
  LocalSbxDispatchBinding,
  LocalSbxExecutorDependencies,
  LocalSbxExecutorReceipt,
  LocalSbxStage
} from './local-sbx-executor-types'

export async function handleLocalSbxCreateFailure(args: {
  dependencies: LocalSbxExecutorDependencies
  binding: LocalSbxDispatchBinding
  sandboxName: string
  create: LocalSbxCommandResult
}): Promise<LocalSbxExecutorReceipt> {
  const inventory = await runLocalSbxCommand(args.dependencies.sbx, sbxInventoryArgs())
  const verdict = commandSucceeded(inventory)
    ? inspectSbxInventory(inventory.stdout, {
        name: args.sandboxName,
        agent: 'codex',
        stopped: false,
        missingIsExited: true
      })
    : 'unverifiable'
  const error = commandFailure(args.create, 'Sandbox creation failed.')
  if (verdict !== 'exited') {
    return recordLocalSbxOutcomeUnknown({
      dependencies: args.dependencies,
      binding: args.binding,
      sandboxName: args.sandboxName,
      stage: 'create',
      error
    })
  }
  await args.dependencies.authority.failDispatch({ binding: args.binding, stage: 'create', error })
  await args.dependencies.authority.closeRunnerTerminal(args.binding.dispatchId)
  return withBinding(args.binding, args.sandboxName, failedReceipt('create', 'released', error))
}

export async function recordLocalSbxOutcomeUnknown(args: {
  dependencies: LocalSbxExecutorDependencies
  binding: LocalSbxDispatchBinding
  sandboxName: string
  stage: LocalSbxStage
  error: string
}): Promise<LocalSbxExecutorReceipt> {
  await args.dependencies.authority.recordOutcomeUnknown({
    binding: args.binding,
    stage: args.stage,
    error: args.error
  })
  await stopAndInspect(args.dependencies.sbx, args.sandboxName)
  return withBinding(args.binding, args.sandboxName, {
    state: 'outcome_unknown',
    stage: args.stage,
    release: 'retained',
    error: args.error
  })
}

export async function releaseSettledLocalSbx(
  dependencies: LocalSbxExecutorDependencies,
  dispatchId: string,
  sandboxName: string
): Promise<Pick<LocalSbxExecutorReceipt, 'stage' | 'release' | 'error'>> {
  const stopped = await stopAndInspect(dependencies.sbx, sandboxName)
  if (!stopped) {
    return {
      stage: 'stopped_inventory',
      release: 'release_unknown',
      error: 'Sandbox stop could not be positively verified.'
    }
  }
  try {
    await dependencies.authority.closeRunnerTerminal(dispatchId)
  } catch (error) {
    return { stage: 'runner_close', release: 'release_unknown', error: errorText(error) }
  }
  return { stage: 'runner_close', release: 'released' }
}

export async function runLocalSbxCommand(
  sbx: LocalSbxArgvAdapter,
  args: readonly string[],
  options?: { input?: string; timeoutMs?: number }
): Promise<LocalSbxCommandResult> {
  try {
    return await sbx.run(args, options)
  } catch (error) {
    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: errorText(error),
      timedOut: false
    }
  }
}

export function commandSucceeded(result: LocalSbxCommandResult): boolean {
  return result.code === 0 && !result.timedOut && result.outputTruncated !== true
}

export function commandFailure(result: LocalSbxCommandResult, fallback: string): string {
  return result.stderr.trim() || fallback
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function failedReceipt(
  stage: LocalSbxStage,
  release: LocalSbxExecutorReceipt['release'],
  error: string
): LocalSbxExecutorReceipt {
  return { state: 'failed', stage, release, error }
}

async function stopAndInspect(sbx: LocalSbxArgvAdapter, sandboxName: string): Promise<boolean> {
  await runLocalSbxCommand(sbx, sbxStopArgs(sandboxName))
  const inventory = await runLocalSbxCommand(sbx, sbxInventoryArgs())
  return (
    commandSucceeded(inventory) &&
    inspectSbxInventory(inventory.stdout, {
      name: sandboxName,
      agent: 'codex',
      stopped: true
    }) === 'exited'
  )
}

function withBinding(
  binding: LocalSbxDispatchBinding,
  sandboxName: string,
  receipt: LocalSbxExecutorReceipt
): LocalSbxExecutorReceipt {
  return {
    ...receipt,
    taskId: binding.taskId,
    dispatchId: binding.dispatchId,
    sandboxName
  }
}
