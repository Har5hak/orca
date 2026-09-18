import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import type { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
import type { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import type {
  LocalLabLaunchLifecycleRecorder,
  PreparedLocalLabLaunchAuthority
} from './local-lab-launch-authority-contract'
import type { createStructuredWorkerSessionForWorktree } from './worker-topology'

export type LocalLabWorkerContinuationDeps = Readonly<{
  prepareLaunchAuthority: (input: {
    prepared: PreparedLocalLabWorkerStart
    identity: Readonly<StructuredWorkerIdentity>
    dispatchCapability: string
    lifecycle: LocalLabLaunchLifecycleRecorder
  }) => Promise<PreparedLocalLabLaunchAuthority>
  createStructuredSession?: typeof createStructuredWorkerSessionForWorktree
  deliverPreamble?: typeof deliverWorkerDispatchPreamble
  tearDownFailedStart?: typeof tearDownFailedWorkerStart
}>
