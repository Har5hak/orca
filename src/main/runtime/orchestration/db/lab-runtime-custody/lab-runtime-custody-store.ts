import {
  beginCodexLabRuntimeCleanup,
  recordCodexLabRuntimeCleanupResult,
  releaseCodexLabRuntimeCustody
} from './lab-runtime-custody-cleanup'
import { releaseCodexLabPreAttachRuntimeCustody } from './lab-runtime-custody-pre-attach-cleanup'
import { recordCodexLabRuntimeLaunchReceipt } from './lab-runtime-custody-launch-receipt'
import { getCodexLabRuntimeCustody } from './lab-runtime-custody-row'
import {
  planCodexLabRuntimeCustody,
  recordCodexLabRuntimeAuthorityAttached,
  recordCodexLabRuntimeExternalAuthInstalled,
  recordCodexLabRuntimeGatewayStarted,
  recordCodexLabRuntimeLayoutPrepared,
  recordCodexLabRuntimeProviderAttached,
  recordCodexLabRuntimeProviderReserved,
  recordCodexLabRuntimeReady
} from './lab-runtime-custody-transitions'

export type CodexLabRuntimeCustodyMethods = {
  getCodexLabRuntimeCustody: typeof getCodexLabRuntimeCustody
  planCodexLabRuntimeCustody: typeof planCodexLabRuntimeCustody
  recordCodexLabRuntimeAuthorityAttached: typeof recordCodexLabRuntimeAuthorityAttached
  recordCodexLabRuntimeLayoutPrepared: typeof recordCodexLabRuntimeLayoutPrepared
  recordCodexLabRuntimeProviderReserved: typeof recordCodexLabRuntimeProviderReserved
  recordCodexLabRuntimeExternalAuthInstalled: typeof recordCodexLabRuntimeExternalAuthInstalled
  recordCodexLabRuntimeGatewayStarted: typeof recordCodexLabRuntimeGatewayStarted
  recordCodexLabRuntimeLaunchReceipt: typeof recordCodexLabRuntimeLaunchReceipt
  recordCodexLabRuntimeProviderAttached: typeof recordCodexLabRuntimeProviderAttached
  recordCodexLabRuntimeReady: typeof recordCodexLabRuntimeReady
  beginCodexLabRuntimeCleanup: typeof beginCodexLabRuntimeCleanup
  recordCodexLabRuntimeCleanupResult: typeof recordCodexLabRuntimeCleanupResult
  releaseCodexLabPreAttachRuntimeCustody: typeof releaseCodexLabPreAttachRuntimeCustody
  releaseCodexLabRuntimeCustody: typeof releaseCodexLabRuntimeCustody
}

export function attachCodexLabRuntimeCustody(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getCodexLabRuntimeCustody,
    planCodexLabRuntimeCustody,
    recordCodexLabRuntimeAuthorityAttached,
    recordCodexLabRuntimeLayoutPrepared,
    recordCodexLabRuntimeProviderReserved,
    recordCodexLabRuntimeExternalAuthInstalled,
    recordCodexLabRuntimeGatewayStarted,
    recordCodexLabRuntimeLaunchReceipt,
    recordCodexLabRuntimeProviderAttached,
    recordCodexLabRuntimeReady,
    beginCodexLabRuntimeCleanup,
    recordCodexLabRuntimeCleanupResult,
    releaseCodexLabPreAttachRuntimeCustody,
    releaseCodexLabRuntimeCustody
  })
}
