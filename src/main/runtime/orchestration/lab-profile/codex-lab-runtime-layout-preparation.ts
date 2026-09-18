import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  CODEX_LAB_LAYOUT_CONFIG_MODE,
  CODEX_LAB_LAYOUT_DIRECTORY_MODE,
  type CodexLabExistingPathObservation,
  type CodexLabPathIdentity,
  type CodexLabRuntimeLayoutHost,
  type CodexLabRuntimeLayoutResult,
  type CodexLabRuntimeLayoutStage,
  type ExpectedCodexLabLayoutPaths
} from './codex-lab-runtime-layout-contract'
import {
  assertCodexLabIdentityUnchanged,
  prepareCodexLabOwnedParents,
  requireCodexLabOwnedDirectory,
  requireCodexLabOwnedFile,
  verifyCapturedCodexLabLayout
} from './codex-lab-runtime-layout-host'
import {
  CodexLabLayoutRefusal,
  DISPATCHES_ROOT,
  codexLabLayoutErrorMessage,
  expectedCodexLabLayoutPaths
} from './codex-lab-runtime-layout-paths'
import { removeCapturedCodexLabDispatchRoot } from './codex-lab-runtime-layout-removal'

/**
 * Materializes only the disposable runtime layout. This function has no provider acquisition,
 * effective-policy probe, keyring access, or process-spawn capability.
 */
export async function prepareCodexLabRuntimeLayout(
  plan: SealedCodexLabLaunchPlan,
  host: CodexLabRuntimeLayoutHost
): Promise<CodexLabRuntimeLayoutResult> {
  let stage: CodexLabRuntimeLayoutStage = 'validate_plan'
  let paths: ExpectedCodexLabLayoutPaths | undefined
  let dispatchRoot: CodexLabExistingPathObservation | undefined
  let dispatchesRootIdentity: CodexLabPathIdentity | undefined
  try {
    paths = expectedCodexLabLayoutPaths(plan)
    assertSealedCodexLabLaunchPlan(plan)
    stage = 'prepare_parents'
    const parents = await prepareCodexLabOwnedParents(host)
    dispatchesRootIdentity = parents.dispatchesRoot.identity
    stage = 'freshness'
    if ((await host.observePath(paths.dispatchRoot)).kind !== 'absent') {
      throw new CodexLabLayoutRefusal('dispatch_root_not_fresh')
    }
    await assertCodexLabIdentityUnchanged(
      host,
      DISPATCHES_ROOT,
      dispatchesRootIdentity,
      'parent_layout_invalid'
    )
    stage = 'create_layout'
    dispatchRoot = await host.makeDirectoryExclusive(
      paths.dispatchRoot,
      CODEX_LAB_LAYOUT_DIRECTORY_MODE,
      dispatchesRootIdentity
    )
    requireCodexLabOwnedDirectory(dispatchRoot)
    await assertCodexLabIdentityUnchanged(host, DISPATCHES_ROOT, dispatchesRootIdentity)
    const codexHome = requireCodexLabOwnedDirectory(
      await host.makeDirectoryExclusive(
        paths.codexHome,
        CODEX_LAB_LAYOUT_DIRECTORY_MODE,
        dispatchRoot.identity
      )
    )
    const fakeHome = requireCodexLabOwnedDirectory(
      await host.makeDirectoryExclusive(
        paths.fakeHome,
        CODEX_LAB_LAYOUT_DIRECTORY_MODE,
        dispatchRoot.identity
      )
    )
    stage = 'write_config'
    const config = requireCodexLabOwnedFile(
      await host.writeFileExclusive(
        paths.configPath,
        plan.configToml,
        CODEX_LAB_LAYOUT_CONFIG_MODE,
        codexHome.identity
      )
    )
    stage = 'verify_layout'
    await verifyCapturedCodexLabLayout({
      host,
      parents,
      paths,
      dispatchRoot,
      codexHome,
      fakeHome,
      config
    })
    stage = 'verify_config_digest'
    const configSha256 = await host.sha256File(paths.configPath, config.identity)
    if (configSha256 !== plan.receiptInputs.configSha256) {
      throw new CodexLabLayoutRefusal('config_digest_mismatch')
    }
    requireCodexLabOwnedFile(await host.observePath(paths.configPath), config.identity)
    await assertCodexLabIdentityUnchanged(host, paths.dispatchRoot, dispatchRoot.identity)
    return {
      ok: true,
      prepared: {
        schemaVersion: 1,
        dispatchId: plan.dispatchId,
        dispatchesRootIdentity,
        dispatchRoot: paths.dispatchRoot,
        dispatchRootIdentity: dispatchRoot.identity,
        codexHome: paths.codexHome,
        codexHomeIdentity: codexHome.identity,
        fakeHome: paths.fakeHome,
        fakeHomeIdentity: fakeHome.identity,
        configPath: paths.configPath,
        configIdentity: config.identity,
        configSha256
      },
      rollback: []
    }
  } catch (error) {
    const rollback = paths
      ? await removeCapturedCodexLabDispatchRoot({
          host,
          dispatchRoot: paths.dispatchRoot,
          dispatchRootIdentity: dispatchRoot?.identity,
          dispatchesRootIdentity
        })
      : []
    return {
      ok: false,
      stage,
      reason:
        error instanceof CodexLabLayoutRefusal
          ? error.reason
          : stage === 'validate_plan'
            ? 'plan_invalid'
            : 'host_operation_failed',
      message: codexLabLayoutErrorMessage(error),
      rollback
    }
  }
}
