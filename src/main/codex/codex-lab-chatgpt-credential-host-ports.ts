import { realpathSync } from 'node:fs'
import { isAbsolute, join, normalize, parse, resolve } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { assertOwnedHostCodexManagedHomePath } from '../codex-accounts/host-codex-managed-home-ownership'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import { getOrcaUserDataPath, getSystemCodexHomePath } from './codex-home-paths'
import {
  CODEX_AUTH_KEYRING_SERVICE,
  codexAuthKeyringAccount,
  type CodexAuthKeyringLocator,
  type CodexLabCredentialMaterializationPorts
} from './codex-lab-chatgpt-credential-materialization'
import {
  deleteKeyringCredential,
  executeSecurityCommand,
  observeTargetAuthJsonPath,
  readCredentialFileSecurely,
  readKeyringCredential,
  type CodexLabSecurityCommandExecutor,
  type TargetAuthJsonObservation
} from './codex-lab-chatgpt-credential-host-storage'

export type {
  CodexLabSecurityCommandExecutor,
  CodexLabSecurityCommandRequest,
  CodexLabSecurityCommandResult
} from './codex-lab-chatgpt-credential-host-storage'

export const CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE =
  'ORCA_CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSED' as const

export type CodexLabCredentialHostPortOperation =
  | 'source_selection'
  | 'source_read'
  | 'target_delete'
  | 'target_read'
  | 'target_write'

export type CodexLabCredentialHostPortRefusalReason =
  | 'credential_file_invalid'
  | 'credential_file_read_failed'
  | 'keyring_command_failed'
  | 'keyring_locator_mismatch'
  | 'platform_unsupported'
  | 'secure_keyring_write_unavailable'
  | 'selected_account_invalid'
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
  executeSecurityCommand?: CodexLabSecurityCommandExecutor
  readCredentialFile?: (filePath: string) => Promise<string | null>
  observeTargetAuthJson?: (filePath: string) => Promise<TargetAuthJsonObservation>
}>

export type CodexLabChatGptCredentialSource = Readonly<{
  readCredential(): Promise<string | null>
}>

/** Source-only credential reader for process-local app-server authentication. */
export function createSelectedHostCodexChatGptCredentialSource(
  source: SelectedHostCodexCredentialSource,
  dependencies: Pick<
    HostPortDependencies,
    'platform' | 'executeSecurityCommand' | 'readCredentialFile'
  > = {}
): CodexLabChatGptCredentialSource {
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    throw refusal('source_selection', 'platform_unsupported')
  }
  assertCanonicalHome(source.canonicalCodexHome, 'source_home_invalid', 'source_selection')
  const execute = dependencies.executeSecurityCommand ?? executeSecurityCommand
  const readCredentialFile =
    dependencies.readCredentialFile ?? ((filePath) => readCredentialFileSecurely(filePath, refusal))
  const sourceLocator = Object.freeze({
    service: CODEX_AUTH_KEYRING_SERVICE,
    account: codexAuthKeyringAccount(source.canonicalCodexHome)
  })
  return Object.freeze({
    async readCredential(): Promise<string | null> {
      try {
        const credential =
          source.storage === 'file'
            ? await readCredentialFile(join(source.canonicalCodexHome, 'auth.json'))
            : await readKeyringCredential(execute, sourceLocator, 'source_read', refusal)
        return credential === null ? null : compactJsonCredential(credential)
      } catch (error) {
        if (error instanceof CodexLabCredentialHostPortRefusal) {
          throw error
        }
        throw refusal('source_read', 'credential_file_read_failed')
      }
    }
  })
}

export function createCodexLabChatGptCredentialHostPorts(
  args: Readonly<{
    source: SelectedHostCodexCredentialSource
    canonicalTargetCodexHome: string
  }>,
  dependencies: HostPortDependencies = {}
): CodexLabCredentialMaterializationPorts {
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    throw refusal('source_selection', 'platform_unsupported')
  }
  assertCanonicalHome(args.source.canonicalCodexHome, 'source_home_invalid', 'source_selection')
  assertCanonicalHome(args.canonicalTargetCodexHome, 'target_home_invalid', 'source_selection')

  const execute = dependencies.executeSecurityCommand ?? executeSecurityCommand
  const observeTargetAuthJson = dependencies.observeTargetAuthJson ?? observeTargetAuthJsonPath
  const targetLocator = Object.freeze({
    service: CODEX_AUTH_KEYRING_SERVICE,
    account: codexAuthKeyringAccount(args.canonicalTargetCodexHome)
  })
  const source = createSelectedHostCodexChatGptCredentialSource(args.source, dependencies)
  const targetAuthJsonPath = join(args.canonicalTargetCodexHome, 'auth.json')

  return Object.freeze({
    source,
    targetKeyring: Object.freeze({
      async writeCredential(entry): Promise<void> {
        assertExactLocator(entry, targetLocator, 'target_write')
        await assertTargetAuthJsonAbsent(targetAuthJsonPath, observeTargetAuthJson, 'target_write')
        // `security -w <secret>` leaks through argv, while prompted `-w` truncates at 128 bytes.
        // Codex's chatgptAuthTokens RPC installs process-local external auth and does not persist.
        throw refusal('target_write', 'secure_keyring_write_unavailable')
      },
      async readCredential(locator): Promise<string | null> {
        assertExactLocator(locator, targetLocator, 'target_read')
        await assertTargetAuthJsonAbsent(targetAuthJsonPath, observeTargetAuthJson, 'target_read')
        const credential = await readKeyringCredential(
          execute,
          targetLocator,
          'target_read',
          refusal
        )
        await assertTargetAuthJsonAbsent(targetAuthJsonPath, observeTargetAuthJson, 'target_read')
        return credential
      },
      async deleteCredential(locator): Promise<void> {
        assertExactLocator(locator, targetLocator, 'target_delete')
        await deleteKeyringCredential(execute, targetLocator, refusal)
        await assertTargetAuthJsonAbsent(targetAuthJsonPath, observeTargetAuthJson, 'target_delete')
      }
    })
  })
}

function assertExactLocator(
  observed: CodexAuthKeyringLocator,
  expected: CodexAuthKeyringLocator,
  operation: 'target_delete' | 'target_read' | 'target_write'
): void {
  if (observed.service !== expected.service || observed.account !== expected.account) {
    throw refusal(operation, 'keyring_locator_mismatch')
  }
}

async function assertTargetAuthJsonAbsent(
  authJsonPath: string,
  observe: NonNullable<HostPortDependencies['observeTargetAuthJson']>,
  operation: 'target_delete' | 'target_read' | 'target_write'
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
