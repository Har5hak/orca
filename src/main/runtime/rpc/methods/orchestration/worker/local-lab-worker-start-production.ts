import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow } from '../../../../orchestration/types'
import { createLocalCodexLabGatewayAuthority } from './local-codex-lab-gateway-authority'
import { prepareLocalCodexLabLaunchAuthority } from './local-codex-lab-launch-authority'
import { createProductionLocalCodexLabLaunchAuthorityDeps } from './local-codex-lab-launch-authority-production'
import { continuePreparedLocalLabWorkerStart } from './local-lab-worker-start-continuation'
import type { LocalLabWorkerContinuationDeps } from './local-lab-worker-start-continuation-contract'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'

export type LocalLabWorkerStartContinuationContext = Readonly<{
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinatorHandle: string
}>

export type LocalLabWorkerStartProductionCompositionDeps = Readonly<{
  continuePreparedStart: typeof continuePreparedLocalLabWorkerStart
  createLaunchAuthorityDeps: typeof createProductionLocalCodexLabLaunchAuthorityDeps
  prepareLaunchAuthority: typeof prepareLocalCodexLabLaunchAuthority
  createGateway: typeof createLocalCodexLabGatewayAuthority
}>

const NATIVE_PRODUCTION_COMPOSITION: LocalLabWorkerStartProductionCompositionDeps = Object.freeze({
  continuePreparedStart: continuePreparedLocalLabWorkerStart,
  createLaunchAuthorityDeps: createProductionLocalCodexLabLaunchAuthorityDeps,
  prepareLaunchAuthority: prepareLocalCodexLabLaunchAuthority,
  createGateway: createLocalCodexLabGatewayAuthority
})

export function continueProductionPreparedLocalLabWorkerStart(
  prepared: PreparedLocalLabWorkerStart,
  context: LocalLabWorkerStartContinuationContext,
  composition: LocalLabWorkerStartProductionCompositionDeps = NATIVE_PRODUCTION_COMPOSITION
): Promise<unknown> {
  const continuationDeps: LocalLabWorkerContinuationDeps = Object.freeze({
    prepareLaunchAuthority: (input) => {
      const deps = composition.createLaunchAuthorityDeps({
        settings: context.runtime.getCodexLabCredentialSelectionSettings(),
        createGateway: (gatewayInput) =>
          composition.createGateway({
            ...gatewayInput,
            runtime: context.runtime,
            db: context.db
          })
      })
      return composition.prepareLaunchAuthority({ ...input, deps })
    }
  })
  return composition.continuePreparedStart({
    prepared,
    runtime: context.runtime,
    db: context.db,
    run: context.run,
    coordinatorHandle: context.coordinatorHandle,
    deps: continuationDeps
  })
}
