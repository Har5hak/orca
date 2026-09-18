import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import type {
  continueProductionPreparedLocalLabWorkerStart,
  LocalLabWorkerStartContinuationContext
} from './local-lab-worker-start-production'

type LocalLabWorkerProductionModule = Readonly<{
  continueProductionPreparedLocalLabWorkerStart: typeof continueProductionPreparedLocalLabWorkerStart
}>

export function createDefaultLocalLabWorkerStartContinuation(
  loadProduction: () => Promise<LocalLabWorkerProductionModule> = () =>
    import('./local-lab-worker-start-production')
): (
  prepared: PreparedLocalLabWorkerStart,
  context: LocalLabWorkerStartContinuationContext
) => Promise<unknown> {
  return async (prepared, context) => {
    const { continueProductionPreparedLocalLabWorkerStart } = await loadProduction()
    return continueProductionPreparedLocalLabWorkerStart(prepared, context)
  }
}
