import { CODEX_LAB_RUNTIME_ROOT } from './codex-lab-launch-contract'
import {
  CODEX_LAB_LAYOUT_DIRECTORY_MODE,
  CODEX_LAB_LAYOUT_CONFIG_MODE,
  type CodexLabExistingPathObservation,
  type CodexLabPathIdentity,
  type CodexLabPathObservation,
  type CodexLabRuntimeLayoutHost,
  type CodexLabRuntimeLayoutReason,
  type ExpectedCodexLabLayoutPaths
} from './codex-lab-runtime-layout-contract'
import {
  CodexLabLayoutRefusal,
  DISPATCHES_ROOT,
  LAB_ROOT,
  PRIVATE_ROOT,
  PRIVATE_TMP_ROOT,
  sameCodexLabPathIdentity
} from './codex-lab-runtime-layout-paths'

export type PreparedCodexLabParentLayout = Readonly<{
  privateRoot: CodexLabExistingPathObservation
  privateTmpRoot: CodexLabExistingPathObservation
  labRoot: CodexLabExistingPathObservation
  runtimeRoot: CodexLabExistingPathObservation
  dispatchesRoot: CodexLabExistingPathObservation
}>

export function requireCodexLabOwnedDirectory(
  observed: CodexLabPathObservation,
  expected?: CodexLabPathIdentity
): CodexLabExistingPathObservation {
  if (
    observed.kind !== 'directory' ||
    observed.mode !== CODEX_LAB_LAYOUT_DIRECTORY_MODE ||
    !observed.ownedByCurrentUser ||
    (expected && !sameCodexLabPathIdentity(observed.identity, expected))
  ) {
    throw new CodexLabLayoutRefusal('layout_verification_failed')
  }
  return observed
}

export function requireCodexLabOwnedFile(
  observed: CodexLabPathObservation,
  expected?: CodexLabPathIdentity
): CodexLabExistingPathObservation {
  if (
    observed.kind !== 'file' ||
    observed.mode !== CODEX_LAB_LAYOUT_CONFIG_MODE ||
    !observed.ownedByCurrentUser ||
    (expected && !sameCodexLabPathIdentity(observed.identity, expected))
  ) {
    throw new CodexLabLayoutRefusal('layout_verification_failed')
  }
  return observed
}

export async function assertCodexLabIdentityUnchanged(
  host: CodexLabRuntimeLayoutHost,
  path: string,
  expected: CodexLabPathIdentity,
  reason: CodexLabRuntimeLayoutReason = 'layout_verification_failed'
): Promise<void> {
  const observed = await host.observePath(path)
  if (observed.kind === 'absent' || !sameCodexLabPathIdentity(observed.identity, expected)) {
    throw new CodexLabLayoutRefusal(reason)
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
  await assertCodexLabIdentityUnchanged(
    args.host,
    args.parentPath,
    args.parentIdentity,
    'parent_layout_invalid'
  )
  const secure = requireCodexLabOwnedDirectory(directory)
  await assertCodexLabIdentityUnchanged(
    args.host,
    args.path,
    secure.identity,
    'parent_layout_invalid'
  )
  return secure
}

function requireDirectory(
  observed: CodexLabPathObservation,
  reason: CodexLabRuntimeLayoutReason
): CodexLabExistingPathObservation {
  if (observed.kind !== 'directory') {
    throw new CodexLabLayoutRefusal(reason)
  }
  return observed
}

export async function prepareCodexLabOwnedParents(
  host: CodexLabRuntimeLayoutHost
): Promise<PreparedCodexLabParentLayout> {
  const privateRoot = requireDirectory(
    await host.observePath(PRIVATE_ROOT),
    'parent_layout_invalid'
  )
  const privateTmpRoot = requireDirectory(
    await host.observePath(PRIVATE_TMP_ROOT),
    'parent_layout_invalid'
  )
  await assertCodexLabIdentityUnchanged(
    host,
    PRIVATE_ROOT,
    privateRoot.identity,
    'parent_layout_invalid'
  )
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

export async function verifyCapturedCodexLabLayout(args: {
  host: CodexLabRuntimeLayoutHost
  parents: PreparedCodexLabParentLayout
  paths: ExpectedCodexLabLayoutPaths
  dispatchRoot: CodexLabExistingPathObservation
  codexHome: CodexLabExistingPathObservation
  fakeHome: CodexLabExistingPathObservation
  config: CodexLabExistingPathObservation
}): Promise<void> {
  await assertCodexLabIdentityUnchanged(args.host, PRIVATE_ROOT, args.parents.privateRoot.identity)
  await assertCodexLabIdentityUnchanged(
    args.host,
    PRIVATE_TMP_ROOT,
    args.parents.privateTmpRoot.identity
  )
  requireCodexLabOwnedDirectory(
    await args.host.observePath(LAB_ROOT),
    args.parents.labRoot.identity
  )
  requireCodexLabOwnedDirectory(
    await args.host.observePath(CODEX_LAB_RUNTIME_ROOT),
    args.parents.runtimeRoot.identity
  )
  requireCodexLabOwnedDirectory(
    await args.host.observePath(DISPATCHES_ROOT),
    args.parents.dispatchesRoot.identity
  )
  requireCodexLabOwnedDirectory(
    await args.host.observePath(args.paths.dispatchRoot),
    args.dispatchRoot.identity
  )
  requireCodexLabOwnedDirectory(
    await args.host.observePath(args.paths.codexHome),
    args.codexHome.identity
  )
  requireCodexLabOwnedDirectory(
    await args.host.observePath(args.paths.fakeHome),
    args.fakeHome.identity
  )
  requireCodexLabOwnedFile(await args.host.observePath(args.paths.configPath), args.config.identity)
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) {
    return undefined
  }
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}
