import type { CodexLabExternalChatGptAuthRegistrationHandle } from '../../../../../codex/codex-lab-external-chatgpt-auth-registration'
import { createCodexLabDynamicToolHostFactory } from '../../../../../codex/codex-lab-dynamic-tool-host'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import type { CodexLabLaunchFacts } from '../../../../orchestration/lab-profile/codex-lab-launch-contract'
import type { CodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import type { VerifiedCodexLabLaunchPreparation } from '../../../../orchestration/lab-profile/codex-lab-command-confinement-live-contract'
import { buildSealedCodexLabLaunchPlan } from '../../../../orchestration/lab-profile/codex-sealed-launch-plan'
import type {
  CodexLabRuntimeLayoutRemovalEvidence,
  CodexLabRuntimeLayoutHost,
  CodexLabRuntimeLayoutResult,
  PreparedCodexLabRuntimeLayout
} from '../../../../orchestration/lab-profile/codex-lab-runtime-layout'
import type { LabGatewayServerReceipt } from '../../../../orchestration/lab-profile/dispatch-gateway-server'
import { registerCodexLabRuntimeCleanupAuthority } from '../../../../orchestration/lab-profile/codex-lab-runtime-cleanup-authority'
import {
  LocalLabLaunchAuthorityPreparationRefusal,
  type LocalLabLaunchLifecycleRecorder,
  type PreparedLocalLabLaunchAuthority
} from './local-lab-launch-authority-contract'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import { publicCodexLabGatewayReceipt } from './local-codex-lab-gateway-public-receipt'

export { publicCodexLabGatewayReceipt } from './local-codex-lab-gateway-public-receipt'

export type LocalCodexLabGatewayAuthority = Readonly<{
  endpoint: string
  credential: string
  start(): Promise<LabGatewayServerReceipt>
  stop(): Promise<void>
}>

export type LocalCodexLabCredentialMetadata = Readonly<{
  workspaceId: string
  planType: string
}>

export type LocalCodexLabLaunchAuthorityDeps = Readonly<{
  createGateway(input: {
    prepared: PreparedLocalLabWorkerStart
    identity: Readonly<StructuredWorkerIdentity>
    dispatchCapability: string
  }): LocalCodexLabGatewayAuthority
  prepareCredential(input: { dispatchId: string; sessionId: string }): Promise<
    Readonly<{
      metadata: LocalCodexLabCredentialMetadata
      register(): CodexLabExternalChatGptAuthRegistrationHandle
    }>
  >
  collectLaunchFacts(input: {
    prepared: PreparedLocalLabWorkerStart
    gateway: Readonly<{ endpoint: string; credential: string }>
    credential: LocalCodexLabCredentialMetadata
  }): Promise<CodexLabLaunchFacts>
  layoutHost: CodexLabRuntimeLayoutHost
  prepareLayout(
    plan: ReturnType<typeof buildSealedCodexLabLaunchPlan>,
    host: CodexLabRuntimeLayoutHost
  ): Promise<CodexLabRuntimeLayoutResult>
  verifyLaunch(input: {
    plan: ReturnType<typeof buildSealedCodexLabLaunchPlan>
    preparedLayout: PreparedCodexLabRuntimeLayout
  }): Promise<VerifiedCodexLabLaunchPreparation>
  removeLayout(input: {
    preparedLayout: PreparedCodexLabRuntimeLayout
    host: CodexLabRuntimeLayoutHost
  }): Promise<CodexLabRuntimeLayoutRemovalEvidence>
}>

/**
 * Creates all host-only authority consumed by the structured pre-attach boundary.
 *
 * The gateway is live before credential authority is registered. Nothing here launches a
 * provider. The returned binding is the only value allowed to cross into structured attach.
 */
export async function prepareLocalCodexLabLaunchAuthority(input: {
  prepared: PreparedLocalLabWorkerStart
  identity: Readonly<StructuredWorkerIdentity>
  dispatchCapability: string
  lifecycle: LocalLabLaunchLifecycleRecorder
  deps: LocalCodexLabLaunchAuthorityDeps
}): Promise<PreparedLocalLabLaunchAuthority> {
  const { prepared, identity, deps } = input
  const dispatchId = prepared.started.dispatch.id
  const gateway = deps.createGateway({
    prepared,
    identity,
    dispatchCapability: input.dispatchCapability
  })
  let gatewayMayNeedStop = false
  let gatewayStopped = false
  let auth: CodexLabExternalChatGptAuthRegistrationHandle | undefined
  let authState: 'not_registered' | 'live' | 'released' | 'claimed' = 'not_registered'
  let preparedLayout: PreparedCodexLabRuntimeLayout | undefined
  let layoutRemoved = false
  let layoutRemovalEvidence: CodexLabRuntimeLayoutRemovalEvidence | undefined
  let layoutRollbackFailure: Error | undefined
  let unregisterCleanupAuthority: (() => boolean) | undefined
  const stopGateway = async (): Promise<void> => {
    if (!gatewayMayNeedStop || gatewayStopped) {
      return
    }
    await gateway.stop()
    gatewayStopped = true
  }
  const removeLayout = async (): Promise<CodexLabRuntimeLayoutRemovalEvidence> => {
    if (layoutRollbackFailure) {
      throw layoutRollbackFailure
    }
    if (!preparedLayout) {
      throw new Error('Codex laboratory runtime layout was not prepared.')
    }
    if (layoutRemoved && layoutRemovalEvidence) {
      return layoutRemovalEvidence
    }
    layoutRemovalEvidence = await deps.removeLayout({ preparedLayout, host: deps.layoutHost })
    layoutRemoved = true
    return layoutRemovalEvidence
  }
  const rollbackHostAuthority = async (): Promise<boolean> => {
    if (authState === 'claimed') {
      return false
    }
    if (authState === 'live') {
      if (!auth?.rollbackIfUnclaimed()) {
        authState = 'claimed'
        return false
      }
      authState = 'released'
    }
    const cleanupErrors: unknown[] = []
    const releases: readonly (() => Promise<unknown>)[] =
      preparedLayout || layoutRollbackFailure ? [stopGateway, removeLayout] : [stopGateway]
    for (const release of releases) {
      try {
        await release()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Codex laboratory host rollback remains pending.')
    }
    return true
  }
  try {
    unregisterCleanupAuthority = registerCodexLabRuntimeCleanupAuthority({
      dispatchId,
      sessionId: identity.sessionId,
      terminalHandle: identity.handle,
      terminalPaneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation,
      stopGateway,
      removeLayout
    })
    const credential = await deps.prepareCredential({ dispatchId, sessionId: identity.sessionId })
    const facts = await deps.collectLaunchFacts({
      prepared,
      gateway: { endpoint: gateway.endpoint, credential: gateway.credential },
      credential: credential.metadata
    })
    assertFactsMatchAdmittedAuthority({ prepared, facts, gateway, credential: credential.metadata })
    const plan = buildSealedCodexLabLaunchPlan(facts)
    const layout = await deps.prepareLayout(plan, deps.layoutHost)
    if (!layout.ok) {
      const failedRollback = layout.rollback.find((entry) => entry.status === 'failed')
      if (failedRollback) {
        layoutRollbackFailure = new Error(failedRollback.evidence)
      }
      throw new Error(`Codex laboratory runtime layout refused: ${layout.reason}`)
    }
    preparedLayout = layout.prepared
    const layoutEvidence = Object.freeze({
      dispatchId,
      profileId: prepared.admission.profile,
      runtimeParentIdentity: preparedLayout.dispatchesRootIdentity,
      runtimeRootIdentity: preparedLayout.dispatchRootIdentity,
      configSha256: preparedLayout.configSha256
    })
    input.lifecycle.recordLayoutPrepared(layoutEvidence)
    input.lifecycle.recordProviderReserved()
    const verified = await deps.verifyLaunch({ plan, preparedLayout })
    if (verified.plan !== plan || verified.preparedLayout !== preparedLayout) {
      throw new Error('Verified Codex laboratory launch preparation changed authority identity.')
    }
    gatewayMayNeedStop = true
    const gatewayReceipt = await gateway.start()
    const publicGatewayReceipt = publicCodexLabGatewayReceipt(gatewayReceipt)
    input.lifecycle.recordGatewayStarted(publicGatewayReceipt)
    auth = credential.register()
    authState = 'live'
    if (
      auth.binding.dispatchId !== dispatchId ||
      auth.binding.sessionId !== identity.sessionId ||
      auth.binding.workspaceId !== plan.enforcedWorkspaceId
    ) {
      throw new Error('Codex laboratory auth registration does not match the sealed launch.')
    }
    const labLaunchBinding: CodexLabStructuredLaunchBinding = Object.freeze({
      dispatchId,
      plan,
      worktree: prepared.observation,
      labDynamicToolHostFactory: createCodexLabDynamicToolHostFactory({
        endpoint: gateway.endpoint,
        credential: gateway.credential,
        expectedReceipt: gatewayReceipt
      })
    })
    return Object.freeze({
      labLaunchBinding,
      layoutEvidence,
      gatewayReceipt: publicGatewayReceipt,
      hostReadinessReceipt: verified.receipt,
      rollbackIfUnclaimed: rollbackHostAuthority,
      releaseCleanupRegistration: unregisterCleanupAuthority
    })
  } catch (error) {
    const cleanupErrors: unknown[] = []
    try {
      if (!(await rollbackHostAuthority())) {
        cleanupErrors.push(new Error('claimed auth authority prevented pre-attach rollback'))
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new LocalLabLaunchAuthorityPreparationRefusal(
        'Codex laboratory launch authority preparation and rollback both failed.',
        false,
        {
          cause: new AggregateError(
            [error, ...cleanupErrors],
            'Codex laboratory launch preparation left cleanup work pending.'
          )
        }
      )
    }
    throw new LocalLabLaunchAuthorityPreparationRefusal(errorMessage(error), true, {
      cause: error,
      releaseCleanupRegistration: unregisterCleanupAuthority
    })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertFactsMatchAdmittedAuthority(input: {
  prepared: PreparedLocalLabWorkerStart
  facts: CodexLabLaunchFacts
  gateway: Readonly<{ endpoint: string; credential: string }>
  credential: LocalCodexLabCredentialMetadata
}): void {
  const { prepared, facts } = input
  if (
    facts.dispatch.id !== prepared.started.dispatch.id ||
    facts.profile !== prepared.admission.profile ||
    facts.adapter !== prepared.admission.adapter ||
    facts.worktree.identity !== prepared.admission.worktreeIdentity ||
    facts.worktree.expectedPath !== prepared.admission.expectedWorktreePath ||
    facts.gateway.socketPath !== input.gateway.endpoint ||
    facts.gateway.credential !== input.gateway.credential ||
    facts.authentication.expectedWorkspaceId !== input.credential.workspaceId ||
    facts.authentication.observedWorkspaceId !== input.credential.workspaceId ||
    facts.authentication.subscription.planType !== input.credential.planType
  ) {
    throw new Error('Collected Codex laboratory facts do not match admitted launch authority.')
  }
}
