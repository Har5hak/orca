import { join } from 'node:path'
import {
  CODEX_AUTH_KEYRING_SERVICE,
  codexAuthKeyringAccount,
  type CodexAuthKeyringLocator
} from './codex-lab-chatgpt-credential-materialization'
import {
  executeSecurityCommand,
  observeCredentialFileSecurely,
  observeKeyringCredential,
  type CodexLabCredentialSourceObservation,
  type CodexLabSecurityCommandExecutor
} from './codex-lab-chatgpt-credential-host-storage'
import {
  CodexLabCredentialHostPortRefusal,
  resolveSelectedHostCodexCredentialSource,
  type CodexLabCredentialSelectionSettings,
  type SelectedHostCodexCredentialSource
} from './codex-lab-chatgpt-credential-host-ports'

type SourceSelectionProbe = (path: string) => Promise<CodexLabCredentialSourceObservation>
type KeyringSelectionProbe = (
  locator: CodexAuthKeyringLocator
) => Promise<CodexLabCredentialSourceObservation>

export type CodexLabCredentialSourceSelectionDependencies = Readonly<{
  platform?: NodeJS.Platform
  executeSecurityCommand?: CodexLabSecurityCommandExecutor
  observeCredentialFile?: SourceSelectionProbe
  observeKeyringCredential?: KeyringSelectionProbe
}>

/** Selects one securely present official Codex credential store; ambiguity is never guessed. */
export async function selectSecureHostCodexCredentialSource(
  args: Readonly<{
    settings: CodexLabCredentialSelectionSettings
    systemCodexHomePath?: string
    managedAccountsRoot?: string
  }>,
  dependencies: CodexLabCredentialSourceSelectionDependencies = {}
): Promise<SelectedHostCodexCredentialSource> {
  if ((dependencies.platform ?? process.platform) !== 'darwin') {
    throw refusal('platform_unsupported')
  }
  const location = resolveSelectedHostCodexCredentialSource({
    ...args,
    storage: 'file'
  })
  const authJsonPath = join(location.canonicalCodexHome, 'auth.json')
  const locator = Object.freeze({
    service: CODEX_AUTH_KEYRING_SERVICE,
    account: codexAuthKeyringAccount(location.canonicalCodexHome)
  })
  const execute = dependencies.executeSecurityCommand ?? executeSecurityCommand
  const observeFile =
    dependencies.observeCredentialFile ??
    ((path: string) => observeCredentialFileSecurely(path, refuseStorage))
  const observeKeyring =
    dependencies.observeKeyringCredential ??
    ((candidate: CodexAuthKeyringLocator) =>
      observeKeyringCredential(execute, candidate, refuseStorage))
  const [file, keyring] = await Promise.all([observeFile(authJsonPath), observeKeyring(locator)])
  const storage = exactStorage(file, keyring)
  return Object.freeze({ ...location, storage })
}

function exactStorage(
  file: CodexLabCredentialSourceObservation,
  keyring: CodexLabCredentialSourceObservation
): SelectedHostCodexCredentialSource['storage'] {
  if (file === 'present' && keyring === 'absent') {
    return 'file'
  }
  if (file === 'absent' && keyring === 'present') {
    return 'keyring'
  }
  throw refusal(file === 'present' ? 'source_ambiguous' : 'source_unavailable')
}

function refuseStorage(
  operation: 'source_read' | 'target_delete' | 'target_read' | 'target_write',
  reason: 'credential_file_invalid' | 'credential_file_read_failed' | 'keyring_command_failed'
): CodexLabCredentialHostPortRefusal {
  return new CodexLabCredentialHostPortRefusal({ operation, reason })
}

function refusal(
  reason: 'platform_unsupported' | 'source_ambiguous' | 'source_unavailable'
): CodexLabCredentialHostPortRefusal {
  return new CodexLabCredentialHostPortRefusal({ operation: 'source_selection', reason })
}
