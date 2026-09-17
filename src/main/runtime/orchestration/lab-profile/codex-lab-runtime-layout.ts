import { join, normalize } from 'node:path'
import { CODEX_LAB_RUNTIME_ROOT, type SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'

export const CODEX_LAB_LAYOUT_DIRECTORY_MODE = 0o700
export const CODEX_LAB_LAYOUT_CONFIG_MODE = 0o600
export const CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE =
  'ORCA_CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE' as const

const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const PRIVATE_ROOT = '/private'
const PRIVATE_TMP_ROOT = '/private/tmp'
const LAB_ROOT = '/private/tmp/orca-lab'
const DISPATCHES_ROOT = join(CODEX_LAB_RUNTIME_ROOT, 'dispatches')

export type CodexLabPathIdentity = Readonly<{
  device: string
  inode: string
}>

export type CodexLabPathObservation =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'directory' | 'file' | 'other'
      mode: number
      ownedByCurrentUser: boolean
      identity: CodexLabPathIdentity
    }>

export type CodexLabExistingPathObservation = Exclude<
  CodexLabPathObservation,
  Readonly<{ kind: 'absent' }>
>

/**
 * The layout host owns filesystem mechanics only. It cannot probe policy or spawn a provider.
 * Every mutating operation is parent-identity fenced; removal additionally requires the exact
 * dev/inode pair captured when this Dispatch root was created.
 */
export type CodexLabRuntimeLayoutHost = Readonly<{
  observePath(path: string): Promise<CodexLabPathObservation>
  makeDirectoryExclusive(
    path: string,
    mode: number,
    expectedParent: CodexLabPathIdentity
  ): Promise<CodexLabExistingPathObservation>
  writeFileExclusive(
    path: string,
    contents: string,
    mode: number,
    expectedParent: CodexLabPathIdentity
  ): Promise<CodexLabExistingPathObservation>
  sha256File(path: string, expectedFile: CodexLabPathIdentity): Promise<string>
  removeTree(
    path: string,
    expectedRoot: CodexLabPathIdentity,
    expectedParent: CodexLabPathIdentity
  ): Promise<Readonly<{ evidence: string }>>
}>

export type PreparedCodexLabRuntimeLayout = Readonly<{
  schemaVersion: 1
  dispatchId: string
  dispatchesRootIdentity: CodexLabPathIdentity
  dispatchRoot: string
  dispatchRootIdentity: CodexLabPathIdentity
  codexHome: string
  codexHomeIdentity: CodexLabPathIdentity
  fakeHome: string
  fakeHomeIdentity: CodexLabPathIdentity
  configPath: string
  configIdentity: CodexLabPathIdentity
  configSha256: string
}>

export type CodexLabRuntimeLayoutStage =
  | 'validate_plan'
  | 'prepare_parents'
  | 'freshness'
  | 'create_layout'
  | 'write_config'
  | 'verify_layout'
  | 'verify_config_digest'

export type CodexLabRuntimeLayoutReason =
  | 'plan_invalid'
  | 'layout_path_invalid'
  | 'parent_layout_invalid'
  | 'dispatch_root_not_fresh'
  | 'layout_verification_failed'
  | 'config_digest_mismatch'
  | 'host_operation_failed'

export type CodexLabRuntimeLayoutRollback =
  | Readonly<{
      action: 'remove_dispatch_root'
      status: 'succeeded'
      evidence: string
    }>
  | Readonly<{
      action: 'remove_dispatch_root'
      status: 'failed'
      reason: 'cleanup_incomplete' | 'cleanup_failed'
      evidence: string
    }>

export type CodexLabRuntimeLayoutResult =
  | Readonly<{
      ok: true
      prepared: PreparedCodexLabRuntimeLayout
      rollback: readonly CodexLabRuntimeLayoutRollback[]
    }>
  | Readonly<{
      ok: false
      stage: CodexLabRuntimeLayoutStage
      reason: CodexLabRuntimeLayoutReason
      message: string
      rollback: readonly CodexLabRuntimeLayoutRollback[]
    }>

type ExpectedLayoutPaths = Readonly<{
  dispatchRoot: string
  codexHome: string
  fakeHome: string
  configPath: string
}>

class LayoutRefusal extends Error {
  constructor(readonly reason: CodexLabRuntimeLayoutReason) {
    super(reason)
  }
}

export class CodexLabRuntimeCleanupIncomplete extends Error {
  readonly code = CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE
  readonly reason = 'cleanup_incomplete' as const

  constructor(readonly quarantinePath: string) {
    super(`Codex laboratory runtime cleanup is incomplete at quarantine path ${quarantinePath}.`)
    this.name = 'CodexLabRuntimeCleanupIncomplete'
  }
}

function expectedLayoutPaths(plan: SealedCodexLabLaunchPlan): ExpectedLayoutPaths {
  const paths = expectedPathsForDispatchId(plan.dispatchId)
  const { dispatchRoot } = paths
  if (
    normalize(plan.runtimePaths.codexHome) !== paths.codexHome ||
    plan.runtimePaths.codexHome !== paths.codexHome ||
    normalize(plan.runtimePaths.fakeHome) !== paths.fakeHome ||
    plan.runtimePaths.fakeHome !== paths.fakeHome ||
    plan.gatewaySocketPath !== join(dispatchRoot, 'gateway.sock')
  ) {
    throw new LayoutRefusal('layout_path_invalid')
  }
  return paths
}

function expectedPathsForDispatchId(dispatchId: string): ExpectedLayoutPaths {
  if (!DISPATCH_ID_PATTERN.test(dispatchId) || dispatchId === '.' || dispatchId === '..') {
    throw new LayoutRefusal('layout_path_invalid')
  }
  const dispatchRoot = join(DISPATCHES_ROOT, dispatchId)
  return {
    dispatchRoot,
    codexHome: join(dispatchRoot, 'codex-home'),
    fakeHome: join(dispatchRoot, 'fake-home'),
    configPath: join(dispatchRoot, 'codex-home', 'config.toml')
  }
}

function sameIdentity(left: CodexLabPathIdentity, right: CodexLabPathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function requireDirectory(
  observed: CodexLabPathObservation,
  reason: CodexLabRuntimeLayoutReason
): CodexLabExistingPathObservation {
  if (observed.kind !== 'directory') {
    throw new LayoutRefusal(reason)
  }
  return observed
}

function requireOwnedDirectory(
  observed: CodexLabPathObservation,
  expected?: CodexLabPathIdentity
): CodexLabExistingPathObservation {
  if (
    observed.kind !== 'directory' ||
    observed.mode !== CODEX_LAB_LAYOUT_DIRECTORY_MODE ||
    !observed.ownedByCurrentUser ||
    (expected && !sameIdentity(observed.identity, expected))
  ) {
    throw new LayoutRefusal('layout_verification_failed')
  }
  return observed
}

function requireOwnedFile(
  observed: CodexLabPathObservation,
  expected?: CodexLabPathIdentity
): CodexLabExistingPathObservation {
  if (
    observed.kind !== 'file' ||
    observed.mode !== CODEX_LAB_LAYOUT_CONFIG_MODE ||
    !observed.ownedByCurrentUser ||
    (expected && !sameIdentity(observed.identity, expected))
  ) {
    throw new LayoutRefusal('layout_verification_failed')
  }
  return observed
}

async function assertIdentityUnchanged(
  host: CodexLabRuntimeLayoutHost,
  path: string,
  expected: CodexLabPathIdentity,
  reason: CodexLabRuntimeLayoutReason = 'layout_verification_failed'
): Promise<void> {
  const observed = await host.observePath(path)
  if (observed.kind === 'absent' || !sameIdentity(observed.identity, expected)) {
    throw new LayoutRefusal(reason)
  }
}

async function ensureOwnedParentDirectory(args: {
  host: CodexLabRuntimeLayoutHost
  path: string
  parentPath: string
  parentIdentity: CodexLabPathIdentity
}): Promise<CodexLabExistingPathObservation> {
  const before = await args.host.observePath(args.path)
  let directory = before
  if (directory.kind === 'absent') {
    try {
      directory = await args.host.makeDirectoryExclusive(
        args.path,
        CODEX_LAB_LAYOUT_DIRECTORY_MODE,
        args.parentIdentity
      )
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') {
        throw error
      }
      directory = await args.host.observePath(args.path)
    }
  }
  await assertIdentityUnchanged(
    args.host,
    args.parentPath,
    args.parentIdentity,
    'parent_layout_invalid'
  )
  const secure = requireOwnedDirectory(directory)
  await assertIdentityUnchanged(args.host, args.path, secure.identity, 'parent_layout_invalid')
  return secure
}

async function prepareOwnedParents(host: CodexLabRuntimeLayoutHost): Promise<
  Readonly<{
    privateRoot: CodexLabExistingPathObservation
    privateTmpRoot: CodexLabExistingPathObservation
    labRoot: CodexLabExistingPathObservation
    runtimeRoot: CodexLabExistingPathObservation
    dispatchesRoot: CodexLabExistingPathObservation
  }>
> {
  const privateRoot = requireDirectory(
    await host.observePath(PRIVATE_ROOT),
    'parent_layout_invalid'
  )
  const privateTmpRoot = requireDirectory(
    await host.observePath(PRIVATE_TMP_ROOT),
    'parent_layout_invalid'
  )
  await assertIdentityUnchanged(host, PRIVATE_ROOT, privateRoot.identity, 'parent_layout_invalid')
  const labRoot = await ensureOwnedParentDirectory({
    host,
    path: LAB_ROOT,
    parentPath: PRIVATE_TMP_ROOT,
    parentIdentity: privateTmpRoot.identity
  })
  const runtimeRoot = await ensureOwnedParentDirectory({
    host,
    path: CODEX_LAB_RUNTIME_ROOT,
    parentPath: LAB_ROOT,
    parentIdentity: labRoot.identity
  })
  const dispatchesRoot = await ensureOwnedParentDirectory({
    host,
    path: DISPATCHES_ROOT,
    parentPath: CODEX_LAB_RUNTIME_ROOT,
    parentIdentity: runtimeRoot.identity
  })
  return { privateRoot, privateTmpRoot, labRoot, runtimeRoot, dispatchesRoot }
}

async function verifyCapturedLayout(args: {
  host: CodexLabRuntimeLayoutHost
  parents: Awaited<ReturnType<typeof prepareOwnedParents>>
  paths: ExpectedLayoutPaths
  dispatchRoot: CodexLabExistingPathObservation
  codexHome: CodexLabExistingPathObservation
  fakeHome: CodexLabExistingPathObservation
  config: CodexLabExistingPathObservation
}): Promise<void> {
  await assertIdentityUnchanged(args.host, PRIVATE_ROOT, args.parents.privateRoot.identity)
  await assertIdentityUnchanged(args.host, PRIVATE_TMP_ROOT, args.parents.privateTmpRoot.identity)
  requireOwnedDirectory(await args.host.observePath(LAB_ROOT), args.parents.labRoot.identity)
  requireOwnedDirectory(
    await args.host.observePath(CODEX_LAB_RUNTIME_ROOT),
    args.parents.runtimeRoot.identity
  )
  requireOwnedDirectory(
    await args.host.observePath(DISPATCHES_ROOT),
    args.parents.dispatchesRoot.identity
  )
  requireOwnedDirectory(
    await args.host.observePath(args.paths.dispatchRoot),
    args.dispatchRoot.identity
  )
  requireOwnedDirectory(await args.host.observePath(args.paths.codexHome), args.codexHome.identity)
  requireOwnedDirectory(await args.host.observePath(args.paths.fakeHome), args.fakeHome.identity)
  requireOwnedFile(await args.host.observePath(args.paths.configPath), args.config.identity)
}

async function removeCapturedDispatchRoot(args: {
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
    return [{ action: 'remove_dispatch_root', status: 'succeeded', evidence: removed.evidence }]
  } catch (error) {
    return [
      {
        action: 'remove_dispatch_root',
        status: 'failed',
        reason:
          error instanceof CodexLabRuntimeCleanupIncomplete
            ? 'cleanup_incomplete'
            : 'cleanup_failed',
        evidence: errorMessage(error)
      }
    ]
  }
}

/**
 * Materializes only the disposable runtime layout. This function has no provider acquisition,
 * effective-policy probe, keyring access, or process-spawn capability.
 */
export async function prepareCodexLabRuntimeLayout(
  plan: SealedCodexLabLaunchPlan,
  host: CodexLabRuntimeLayoutHost
): Promise<CodexLabRuntimeLayoutResult> {
  let stage: CodexLabRuntimeLayoutStage = 'validate_plan'
  let paths: ExpectedLayoutPaths | undefined
  let dispatchRoot: CodexLabExistingPathObservation | undefined
  let dispatchesRootIdentity: CodexLabPathIdentity | undefined
  try {
    paths = expectedLayoutPaths(plan)
    assertSealedCodexLabLaunchPlan(plan)
    stage = 'prepare_parents'
    const parents = await prepareOwnedParents(host)
    dispatchesRootIdentity = parents.dispatchesRoot.identity
    stage = 'freshness'
    if ((await host.observePath(paths.dispatchRoot)).kind !== 'absent') {
      throw new LayoutRefusal('dispatch_root_not_fresh')
    }
    await assertIdentityUnchanged(
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
    requireOwnedDirectory(dispatchRoot)
    await assertIdentityUnchanged(host, DISPATCHES_ROOT, dispatchesRootIdentity)
    const codexHome = requireOwnedDirectory(
      await host.makeDirectoryExclusive(
        paths.codexHome,
        CODEX_LAB_LAYOUT_DIRECTORY_MODE,
        dispatchRoot.identity
      )
    )
    const fakeHome = requireOwnedDirectory(
      await host.makeDirectoryExclusive(
        paths.fakeHome,
        CODEX_LAB_LAYOUT_DIRECTORY_MODE,
        dispatchRoot.identity
      )
    )
    stage = 'write_config'
    const config = requireOwnedFile(
      await host.writeFileExclusive(
        paths.configPath,
        plan.configToml,
        CODEX_LAB_LAYOUT_CONFIG_MODE,
        codexHome.identity
      )
    )
    stage = 'verify_layout'
    await verifyCapturedLayout({
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
      throw new LayoutRefusal('config_digest_mismatch')
    }
    requireOwnedFile(await host.observePath(paths.configPath), config.identity)
    await assertIdentityUnchanged(host, paths.dispatchRoot, dispatchRoot.identity)
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
      ? await removeCapturedDispatchRoot({
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
        error instanceof LayoutRefusal
          ? error.reason
          : stage === 'validate_plan'
            ? 'plan_invalid'
            : 'host_operation_failed',
      message: errorMessage(error),
      rollback
    }
  }
}

export async function removeCodexLabRuntimeLayout(
  prepared: PreparedCodexLabRuntimeLayout,
  host: Pick<CodexLabRuntimeLayoutHost, 'removeTree'>
): Promise<readonly CodexLabRuntimeLayoutRollback[]> {
  try {
    const expected = expectedPathsForDispatchId(prepared.dispatchId)
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
      throw new LayoutRefusal('layout_path_invalid')
    }
  } catch (error) {
    return [
      {
        action: 'remove_dispatch_root',
        status: 'failed',
        reason: 'cleanup_failed',
        evidence: errorMessage(error)
      }
    ]
  }
  return removeCapturedDispatchRoot({
    host,
    dispatchRoot: prepared.dispatchRoot,
    dispatchRootIdentity: prepared.dispatchRootIdentity,
    dispatchesRootIdentity: prepared.dispatchesRootIdentity
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown layout host failure'
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined
  }
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}
