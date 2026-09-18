import { realpathSync } from 'node:fs'
import { isAbsolute, join, normalize, parse, resolve } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { assertOwnedHostCodexManagedHomePath } from '../codex-accounts/host-codex-managed-home-ownership'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import {
  CODEX_LAB_RUNTIME_ROOT,
  type SealedCodexLabLaunchPlan
} from '../runtime/orchestration/lab-profile/codex-lab-launch-contract'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import {
  CODEX_AUTH_KEYRING_SERVICE,
  codexAuthKeyringAccount,
  type CodexAuthKeyringLocator,
  type CodexLabCredentialMaterializationPorts
} from './codex-lab-chatgpt-credential-materialization'
import {
  deleteKeyringCredentialWithWriter,
  executeCodexLabKeychainWriter,
  installKeyringCredentialWithWriter,
  observeTargetAuthJsonPath,
  readCredentialFileSecurely,
  resolveCodexLabKeychainWriterPath,
  type CodexLabKeychainWriterExecutor,
  type TargetAuthJsonObservation
} from './codex-lab-chatgpt-credential-host-storage'

export type {
  CodexLabKeychainWriterExecutor,
  CodexLabKeychainWriterRequest,
  CodexLabKeychainWriterResult
} from './codex-lab-chatgpt-credential-host-storage'

export const CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE =
  'ORCA_CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSED' as const

export type CodexLabCredentialHostPortOperation =
  | 'source_selection'
  | 'source_read'
  | 'target_delete'
  | 'target_write'

export type CodexLabCredentialHostPortRefusalReason =
  | 'credential_file_invalid'
  | 'credential_file_read_failed'
  | 'keyring_locator_mismatch'
  | 'keyring_writer_failed'
  | 'platform_unsupported'
  | 'sealed_executable_identity_missing'
  | 'sealed_launch_plan_mismatch'
  | 'secure_keyring_write_unavailable'
  | 'selected_account_invalid'
  | 'source_keyring_unproven'
  | 'source_home_invalid'
  | 'target_auth_json_observation_failed'
  | 'target_auth_json_present'
  | 'target_home_invalid'

export class CodexLabCredentialHostPortRefusal extends Error {
  readonly code = CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE

  constructor(
    readonly data: Readonly<{
      operation: CodexLabCredentialHostPortOperation
      reason: CodexLabCredentialHostPortRefusalReason
    }>
  ) {
    super(`Codex laboratory credential host port refused: ${data.operation}/${data.reason}`)
    this.name = 'CodexLabCredentialHostPortRefusal'
  }
}

export type CodexLabCredentialSourceStorage = 'file' | 'keyring'

export type SelectedHostCodexCredentialSource = Readonly<{
  storage: CodexLabCredentialSourceStorage
  canonicalCodexHome: string
  selectedAccountId: string | null
}>

type SelectionSettings = Pick<
  GlobalSettings,
  'activeCodexManagedAccountId' | 'activeCodexManagedAccountIdsByRuntime' | 'codexManagedAccounts'
>

type SourceSelectionDependencies = Readonly<{
  canonicalizeSystemHome?: (candidatePath: string) => string
  assertManagedHome?: (candidatePath: string, expectedAccountId: string) => string
}>

/** Resolve the host lane only; laboratory workers never borrow a WSL credential lane. */
export function resolveSelectedHostCodexCredentialSource(
  args: Readonly<{
    settings: SelectionSettings
    storage: CodexLabCredentialSourceStorage
    systemCodexHomePath?: string
    managedAccountsRoot?: string
  }>,
  dependencies: SourceSelectionDependencies = {}
): SelectedHostCodexCredentialSource {
  const systemCodexHomePath = args.systemCodexHomePath ?? getSystemCodexHomePath()
  const selectedAccountId = getSelectedCodexAccountIdForTarget(args.settings, {
    runtime: 'host'
  })
  try {
    if (selectedAccountId === null) {
      const canonicalCodexHome = (dependencies.canonicalizeSystemHome ?? canonicalizeCodexHome)(
        systemCodexHomePath
      )
      assertCanonicalHome(canonicalCodexHome, 'source_home_invalid', 'source_selection')
      return Object.freeze({
        storage: args.storage,
        canonicalCodexHome,
        selectedAccountId: null
      })
    }

    const matches = args.settings.codexManagedAccounts.filter(
      (account) => account.id === selectedAccountId
    )
    const account = matches.length === 1 ? matches[0] : undefined
    if (!account || account.managedHomeRuntime === 'wsl') {
      throw refusal('source_selection', 'selected_account_invalid')
    }
    const canonicalCodexHome = dependencies.assertManagedHome
      ? dependencies.assertManagedHome(account.managedHomePath, account.id)
      : assertOwnedHostCodexManagedHomePath({
          candidatePath: account.managedHomePath,
          managedAccountsRoot:
            args.managedAccountsRoot ?? join(getOrcaUserDataPath(), 'codex-accounts'),
          systemCodexHomePath,
          expectedAccountId: account.id
        })
    assertCanonicalHome(canonicalCodexHome, 'source_home_invalid', 'source_selection')
    return Object.freeze({
      storage: args.storage,
      canonicalCodexHome,
      selectedAccountId: account.id
    })
  } catch (error) {
    if (error instanceof CodexLabCredentialHostPortRefusal) {
      throw error
    }
    throw refusal('source_selection', 'selected_account_invalid')
  }
}

type HostPortDependencies = Readonly<{
  platform?: NodeJS.Platform
  executeKeychainWriter?: CodexLabKeychainWriterExecutor
  keychainWriterPath?: string | null
  readCredentialFile?: (filePath: string) => Promise<string | null>
  observeTargetAuthJson?: (filePath: string) => Promise<TargetAuthJsonObservation>
}>

export type CodexLabCredentialLaunchPlan = Pick<
  SealedCodexLabLaunchPlan,
  'codexExecutableSha256' | 'dispatchId' | 'executable' | 'runtimePaths'
>

export function createCodexLabChatGptCredentialHostPorts(
  args: Readonly<{
    source: SelectedHostCodexCredentialSource
    dispatchId: string
    canonicalTargetCodexHome: string
    launchPlan: CodexLabCredentialLaunchPlan
  }>,
  dependencies: HostPortDependencies = {}
): CodexLabCredentialMaterializationPorts {
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    throw refusal('source_selection', 'platform_unsupported')
  }
  assertCanonicalHome(args.source.canonicalCodexHome, 'source_home_invalid', 'source_selection')
  assertCanonicalHome(args.canonicalTargetCodexHome, 'target_home_invalid', 'source_selection')
  assertDispatchBoundTarget(args.dispatchId, args.canonicalTargetCodexHome)
  assertLaunchPlanMatches(args.launchPlan, args.dispatchId, args.canonicalTargetCodexHome)

  const executeWriter = dependencies.executeKeychainWriter ?? executeCodexLabKeychainWriter
  const keychainWriterPath =
    dependencies.keychainWriterPath === undefined
      ? resolveCodexLabKeychainWriterPath()
      : dependencies.keychainWriterPath
  const readCredentialFile =
    dependencies.readCredentialFile ?? ((filePath) => readCredentialFileSecurely(filePath, refusal))
  const observeTargetAuthJson = dependencies.observeTargetAuthJson ?? observeTargetAuthJsonPath
  const targetLocator = Object.freeze({
    service: CODEX_AUTH_KEYRING_SERVICE,
    account: codexAuthKeyringAccount(args.canonicalTargetCodexHome)
  })
  const targetAuthJsonPath = join(args.canonicalTargetCodexHome, 'auth.json')

  return Object.freeze({
    source: Object.freeze({
      async readCredential(): Promise<string | null> {
        try {
          if (args.source.storage !== 'file') {
            throw refusal('source_read', 'source_keyring_unproven')
          }
          const credential = await readCredentialFile(
            join(args.source.canonicalCodexHome, 'auth.json')
          )
          return credential === null ? null : compactJsonCredential(credential)
        } catch (error) {
          if (error instanceof CodexLabCredentialHostPortRefusal) {
            throw error
          }
          throw refusal('source_read', 'credential_file_read_failed')
        }
      }
    }),
    targetKeyring: Object.freeze({
      async replaceAndVerifyCredential(entry): Promise<void> {
        assertExactLocator(entry, targetLocator, 'target_write')
        await assertTargetAuthJsonAbsent(targetAuthJsonPath, observeTargetAuthJson, 'target_write')
        const executableIdentity = requireSealedExecutableIdentity(args.launchPlan, 'target_write')
        if (keychainWriterPath === null) {
          throw refusal('target_write', 'secure_keyring_write_unavailable')
        }
        await installKeyringCredentialWithWriter(
          executeWriter,
          keychainWriterPath,
          args.dispatchId,
          executableIdentity.canonicalPath,
          entry.secret,
          refusal
        )
        await assertTargetAuthJsonAbsent(targetAuthJsonPath, observeTargetAuthJson, 'target_write')
      },
      async deleteCredential(locator): Promise<void> {
        assertExactLocator(locator, targetLocator, 'target_delete')
        requireSealedExecutableIdentity(args.launchPlan, 'target_delete')
        if (keychainWriterPath === null) {
          throw refusal('target_delete', 'secure_keyring_write_unavailable')
        }
        await deleteKeyringCredentialWithWriter(
          executeWriter,
          keychainWriterPath,
          args.dispatchId,
          refusal
        )
        await assertTargetAuthJsonAbsent(targetAuthJsonPath, observeTargetAuthJson, 'target_delete')
      }
    })
  })
}

const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

type SealedExecutableIdentity = Readonly<{
  canonicalPath: string
  sha256: string
  device: string
  inode: string
}>

function assertLaunchPlanMatches(
  plan: CodexLabCredentialLaunchPlan,
  dispatchId: string,
  targetHome: string
): void {
  if (
    plan.dispatchId !== dispatchId ||
    plan.runtimePaths.codexHome !== targetHome ||
    !isAbsolute(plan.executable) ||
    normalize(plan.executable) !== plan.executable ||
    parse(plan.executable).root === plan.executable ||
    !SHA256_PATTERN.test(plan.codexExecutableSha256)
  ) {
    throw refusal('source_selection', 'sealed_launch_plan_mismatch')
  }
}

/**
 * Deliberately fail closed. `SealedCodexLabLaunchPlan` currently carries only canonical path and
 * SHA-256. TASK-757 must not invent device/inode as ambient caller data. The upstream contract must
 * add values observed while sealing and the materializer must re-observe the same identity before
 * this function may return a value.
 */
function requireSealedExecutableIdentity(
  _plan: CodexLabCredentialLaunchPlan,
  operation: 'target_delete' | 'target_write'
): SealedExecutableIdentity {
  throw refusal(operation, 'sealed_executable_identity_missing')
}

function assertDispatchBoundTarget(dispatchId: string, targetHome: string): void {
  if (
    !DISPATCH_ID_PATTERN.test(dispatchId) ||
    dispatchId === '.' ||
    dispatchId === '..' ||
    targetHome !== join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId, 'codex-home')
  ) {
    throw refusal('source_selection', 'target_home_invalid')
  }
}

function assertExactLocator(
  observed: CodexAuthKeyringLocator,
  expected: CodexAuthKeyringLocator,
  operation: 'target_delete' | 'target_write'
): void {
  if (observed.service !== expected.service || observed.account !== expected.account) {
    throw refusal(operation, 'keyring_locator_mismatch')
  }
}

async function assertTargetAuthJsonAbsent(
  authJsonPath: string,
  observe: NonNullable<HostPortDependencies['observeTargetAuthJson']>,
  operation: 'target_delete' | 'target_write'
): Promise<void> {
  let observation: TargetAuthJsonObservation
  try {
    observation = await observe(authJsonPath)
  } catch {
    throw refusal(operation, 'target_auth_json_observation_failed')
  }
  if (observation === 'present') {
    throw refusal(operation, 'target_auth_json_present')
  }
  if (observation !== 'absent') {
    throw refusal(operation, 'target_auth_json_observation_failed')
  }
}

function canonicalizeCodexHome(candidatePath: string): string {
  assertCanonicalHome(candidatePath, 'source_home_invalid', 'source_selection')
  try {
    return realpathSync(candidatePath)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return resolve(candidatePath)
    }
    throw error
  }
}

function assertCanonicalHome(
  candidatePath: string,
  reason: 'source_home_invalid' | 'target_home_invalid',
  operation: CodexLabCredentialHostPortOperation
): void {
  if (
    !candidatePath ||
    !isAbsolute(candidatePath) ||
    normalize(candidatePath) !== candidatePath ||
    parse(candidatePath).root === candidatePath
  ) {
    throw refusal(operation, reason)
  }
}

function compactJsonCredential(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value))
  } catch {
    return value
  }
}

function refusal(
  operation: CodexLabCredentialHostPortOperation,
  reason: CodexLabCredentialHostPortRefusalReason
): CodexLabCredentialHostPortRefusal {
  return new CodexLabCredentialHostPortRefusal({ operation, reason })
}
