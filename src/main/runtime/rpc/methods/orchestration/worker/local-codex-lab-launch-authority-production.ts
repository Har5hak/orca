import {
  createSelectedHostCodexChatGptCredentialSource,
  type CodexLabCredentialSelectionSettings
} from '../../../../../codex/codex-lab-chatgpt-credential-host-ports'
import { selectSecureHostCodexCredentialSource } from '../../../../../codex/codex-lab-chatgpt-credential-source-selection'
import { prepareCodexLabExternalChatGptCredential } from '../../../../../codex/codex-lab-external-chatgpt-auth-registration'
import { createNativeCodexLabLiveConfinementHost } from '../../../../orchestration/lab-profile/codex-lab-command-confinement-live-native'
import { prepareVerifiedCodexLabLaunch } from '../../../../orchestration/lab-profile/codex-lab-command-confinement-live'
import {
  collectCodexLabLaunchFacts,
  createNativeCodexLabLaunchFactsCollectorHost
} from '../../../../orchestration/lab-profile/codex-lab-launch-facts-collector'
import {
  prepareCodexLabRuntimeLayout,
  removeCodexLabRuntimeLayout,
  requireCodexLabRuntimeLayoutRemovalEvidence
} from '../../../../orchestration/lab-profile/codex-lab-runtime-layout'
import { createNativeCodexLabRuntimeLayoutHost } from '../../../../orchestration/lab-profile/codex-lab-runtime-layout-native'
import { resolveSupportedCodexLabExecutable } from '../../../../orchestration/lab-profile/codex-lab-supported-binary'
import type {
  LocalCodexLabGatewayAuthority,
  LocalCodexLabLaunchAuthorityDeps
} from './local-codex-lab-launch-authority'

export function createProductionLocalCodexLabLaunchAuthorityDeps(
  input: Readonly<{
    settings: CodexLabCredentialSelectionSettings
    createGateway: LocalCodexLabLaunchAuthorityDeps['createGateway']
  }>
): LocalCodexLabLaunchAuthorityDeps {
  const layoutHost = createNativeCodexLabRuntimeLayoutHost()
  const factsHost = createNativeCodexLabLaunchFactsCollectorHost()
  const confinementHost = createNativeCodexLabLiveConfinementHost()
  const executable = resolveSupportedCodexLabExecutable()
  return Object.freeze({
    createGateway: input.createGateway,
    async prepareCredential({ dispatchId, sessionId }) {
      const selected = await selectSecureHostCodexCredentialSource({ settings: input.settings })
      const expectedWorkspaceId = selected.selectedAccountId
        ? (input.settings.codexManagedAccounts.find(
            (account) => account.id === selected.selectedAccountId
          )?.workspaceAccountId ?? undefined)
        : undefined
      const credential = await prepareCodexLabExternalChatGptCredential({
        ...(expectedWorkspaceId ? { workspaceId: expectedWorkspaceId } : {}),
        source: createSelectedHostCodexChatGptCredentialSource(selected)
      })
      return Object.freeze({
        metadata: credential.metadata,
        register: () => credential.register({ dispatchId, sessionId })
      })
    },
    collectLaunchFacts: async ({ prepared, gateway, credential }) =>
      collectCodexLabLaunchFacts({
        prepared,
        gateway,
        credential,
        executable,
        host: factsHost
      }),
    layoutHost,
    prepareLayout: prepareCodexLabRuntimeLayout,
    verifyLaunch: ({ plan, preparedLayout }) =>
      prepareVerifiedCodexLabLaunch({ plan, preparedLayout }, confinementHost),
    async removeLayout({ preparedLayout, host }) {
      const results = await removeCodexLabRuntimeLayout(preparedLayout, host)
      const result = results.length === 1 ? results[0] : undefined
      if (!result || result.status !== 'succeeded') {
        throw new Error('Codex laboratory runtime layout cleanup was not proven.')
      }
      const evidence = Object.freeze({
        evidence: result.evidence,
        ...(result.quarantinePath ? { quarantinePath: result.quarantinePath } : {}),
        ...(result.rootIdentity ? { rootIdentity: result.rootIdentity } : {})
      })
      requireCodexLabRuntimeLayoutRemovalEvidence({
        dispatchRoot: preparedLayout.dispatchRoot,
        expectedRootIdentity: preparedLayout.dispatchRootIdentity,
        evidence
      })
      return evidence
    }
  })
}

export type { LocalCodexLabGatewayAuthority }
