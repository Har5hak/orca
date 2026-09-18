import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CodexLabCredentialSelectionSettings } from '../codex/codex-lab-chatgpt-credential-host-ports'

type RuntimeCodexCredentialSettingsSource = Readonly<{
  codexManagedAccounts?: GlobalSettings['codexManagedAccounts']
  activeCodexManagedAccountId?: GlobalSettings['activeCodexManagedAccountId']
  activeCodexManagedAccountIdsByRuntime?: GlobalSettings['activeCodexManagedAccountIdsByRuntime']
}>

export function snapshotCodexLabCredentialSelectionSettings(
  settings: RuntimeCodexCredentialSettingsSource
): CodexLabCredentialSelectionSettings {
  const legacySelection = settings.activeCodexManagedAccountId
  const validLegacySelection =
    legacySelection === null || (typeof legacySelection === 'string' && legacySelection.length > 0)
  if (
    !Array.isArray(settings.codexManagedAccounts) ||
    !Object.hasOwn(settings, 'activeCodexManagedAccountId') ||
    !validLegacySelection
  ) {
    throw new Error('Codex laboratory credential selection settings are unavailable.')
  }
  const runtimeSelection = settings.activeCodexManagedAccountIdsByRuntime
  if (
    runtimeSelection &&
    !(
      runtimeSelection.host === null ||
      (typeof runtimeSelection.host === 'string' && runtimeSelection.host.length > 0)
    )
  ) {
    throw new Error('Codex laboratory credential selection settings are unavailable.')
  }
  return Object.freeze({
    activeCodexManagedAccountId: legacySelection,
    ...(runtimeSelection
      ? {
          activeCodexManagedAccountIdsByRuntime: Object.freeze({
            host: runtimeSelection.host,
            wsl: Object.freeze({ ...runtimeSelection.wsl })
          })
        }
      : {}),
    codexManagedAccounts: Object.freeze(
      settings.codexManagedAccounts.map((account) => Object.freeze({ ...account }))
    )
  })
}
