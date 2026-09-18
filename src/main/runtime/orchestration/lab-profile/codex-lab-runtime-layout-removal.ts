import type {
  CodexLabPathIdentity,
  CodexLabRuntimeLayoutHost,
  CodexLabRuntimeLayoutRollback,
  PreparedCodexLabRuntimeLayout
} from './codex-lab-runtime-layout-contract'
import { CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE } from './codex-lab-runtime-layout-contract'
import {
  CodexLabLayoutRefusal,
  codexLabLayoutErrorMessage,
  expectedCodexLabLayoutPathsForDispatchId
} from './codex-lab-runtime-layout-paths'

export class CodexLabRuntimeCleanupIncomplete extends Error {
  readonly code = CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE
  readonly reason = 'cleanup_incomplete' as const

  constructor(readonly quarantinePath: string) {
    super(`Codex laboratory runtime cleanup is incomplete at quarantine path ${quarantinePath}.`)
    this.name = 'CodexLabRuntimeCleanupIncomplete'
  }
}

export async function removeCapturedCodexLabDispatchRoot(args: {
  host: Pick<CodexLabRuntimeLayoutHost, 'removeTree'>
  dispatchRoot: string
  dispatchRootIdentity?: CodexLabPathIdentity
  dispatchesRootIdentity?: CodexLabPathIdentity
}): Promise<readonly CodexLabRuntimeLayoutRollback[]> {
  if (!args.dispatchRootIdentity || !args.dispatchesRootIdentity) {
    return []
  }
  try {
    const removed = await args.host.removeTree(
      args.dispatchRoot,
      args.dispatchRootIdentity,
      args.dispatchesRootIdentity
    )
    return [
      {
        action: 'remove_dispatch_root',
        status: 'succeeded',
        evidence: removed.evidence,
        ...(removed.quarantinePath ? { quarantinePath: removed.quarantinePath } : {}),
        ...(removed.rootIdentity ? { rootIdentity: removed.rootIdentity } : {})
      }
    ]
  } catch (error) {
    return [
      {
        action: 'remove_dispatch_root',
        status: 'failed',
        reason:
          error instanceof CodexLabRuntimeCleanupIncomplete
            ? 'cleanup_incomplete'
            : 'cleanup_failed',
        evidence: codexLabLayoutErrorMessage(error)
      }
    ]
  }
}

export async function removeCodexLabRuntimeLayout(
  prepared: PreparedCodexLabRuntimeLayout,
  host: Pick<CodexLabRuntimeLayoutHost, 'removeTree'>
): Promise<readonly CodexLabRuntimeLayoutRollback[]> {
  try {
    const expected = expectedCodexLabLayoutPathsForDispatchId(prepared.dispatchId)
    if (
      prepared.schemaVersion !== 1 ||
      prepared.dispatchRoot !== expected.dispatchRoot ||
      prepared.codexHome !== expected.codexHome ||
      prepared.fakeHome !== expected.fakeHome ||
      prepared.configPath !== expected.configPath ||
      !prepared.dispatchRootIdentity.device ||
      !prepared.dispatchRootIdentity.inode ||
      !prepared.dispatchesRootIdentity.device ||
      !prepared.dispatchesRootIdentity.inode
    ) {
      throw new CodexLabLayoutRefusal('layout_path_invalid')
    }
  } catch (error) {
    return [
      {
        action: 'remove_dispatch_root',
        status: 'failed',
        reason: 'cleanup_failed',
        evidence: codexLabLayoutErrorMessage(error)
      }
    ]
  }
  return removeCapturedCodexLabDispatchRoot({
    host,
    dispatchRoot: prepared.dispatchRoot,
    dispatchRootIdentity: prepared.dispatchRootIdentity,
    dispatchesRootIdentity: prepared.dispatchesRootIdentity
  })
}
