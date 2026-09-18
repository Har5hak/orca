import {
  createSelectedHostCodexChatGptCredentialSource,
  type CodexLabCredentialSelectionSettings
} from './codex-lab-chatgpt-credential-host-ports'
import { selectSecureHostCodexCredentialSource } from './codex-lab-chatgpt-credential-source-selection'
import {
  prepareCodexLabExternalChatGptCredential,
  type PreparedCodexLabExternalChatGptCredential
} from './codex-lab-external-chatgpt-auth-registration'

export async function prepareSelectedHostCodexLabCredential(
  settings: CodexLabCredentialSelectionSettings
): Promise<PreparedCodexLabExternalChatGptCredential> {
  const selected = await selectSecureHostCodexCredentialSource({ settings })
  const expectedWorkspaceId = selected.selectedAccountId
    ? (settings.codexManagedAccounts.find((account) => account.id === selected.selectedAccountId)
        ?.workspaceAccountId ?? undefined)
    : undefined
  return prepareCodexLabExternalChatGptCredential({
    ...(expectedWorkspaceId ? { workspaceId: expectedWorkspaceId } : {}),
    source: createSelectedHostCodexChatGptCredentialSource(selected)
  })
}

export async function readSelectedHostCodexLabCredentialMetadata(
  settings: CodexLabCredentialSelectionSettings
): Promise<Readonly<{ workspaceId: string; planType: string }>> {
  const prepared = await prepareSelectedHostCodexLabCredential(settings)
  return Object.freeze({ ...prepared.metadata })
}
