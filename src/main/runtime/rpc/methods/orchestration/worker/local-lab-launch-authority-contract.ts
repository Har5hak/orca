import type {
  CodexLabGatewayPublicReceipt,
  CodexLabRuntimeLayoutEvidence
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-contract'
import type { CodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import type { CodexLabHostReadinessReceipt } from '../../../../orchestration/lab-profile/codex-lab-command-confinement-live-contract'

export type PreparedLocalLabLaunchAuthority = Readonly<{
  labLaunchBinding: CodexLabStructuredLaunchBinding
  layoutEvidence: CodexLabRuntimeLayoutEvidence
  gatewayReceipt: CodexLabGatewayPublicReceipt
  hostReadinessReceipt: CodexLabHostReadinessReceipt
  /** Atomic: releases only unclaimed authority; a claimed provider remains exit-custodied. */
  rollbackIfUnclaimed: () => Promise<boolean>
  /** Drops process-local cleanup capability only after durable custody reached `released`. */
  releaseCleanupRegistration: () => boolean
}>

/** A host-preparation refusal whose rollback outcome is part of the authority contract. */
export class LocalLabLaunchAuthorityPreparationRefusal extends Error {
  readonly name = 'LocalLabLaunchAuthorityPreparationRefusal'

  constructor(
    message: string,
    readonly cleanupProven: boolean,
    options?: ErrorOptions & Readonly<{ releaseCleanupRegistration?: () => boolean }>
  ) {
    super(message, options)
    this.releaseCleanupRegistration = options?.releaseCleanupRegistration
  }

  readonly releaseCleanupRegistration: (() => boolean) | undefined
}

export type LocalLabLaunchLifecycleRecorder = Readonly<{
  recordLayoutPrepared(evidence: CodexLabRuntimeLayoutEvidence): void
  recordProviderReserved(): void
  recordGatewayStarted(receipt: CodexLabGatewayPublicReceipt): void
}>
