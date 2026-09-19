import { join } from 'node:path'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow } from '../../../../orchestration/types'
import { CODEX_LAB_RUNTIME_ROOT } from '../../../../orchestration/lab-profile/codex-lab-launch-contract'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import { createStructuredWorkerSessionForWorktree, type WorkerEffect } from './worker-topology'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'
import {
  LocalLabLaunchAuthorityPreparationRefusal,
  type LocalLabLaunchLifecycleRecorder,
  type PreparedLocalLabLaunchAuthority
} from './local-lab-launch-authority-contract'
import type { LocalLabWorkerContinuationDeps } from './local-lab-worker-start-continuation-contract'
import { reconcileExitedFailedLabProvider } from './local-lab-worker-start-recovery'
import {
  buildCodexLabLaunchReceipt,
  type CodexLabLaunchReceiptV1
} from '../../../../orchestration/lab-profile/codex-lab-launch-receipt'
import {
  failedLocalLabWorkerStartResult,
  readyLocalLabWorkerStartResult,
  settledLocalLabWorkerStartFailureResult
} from './local-lab-worker-start-result'

/**
 * Finishes the lifecycle after admission has durably reserved the laboratory runtime.
 *
 * Host preparation remains behind one narrow callback because it is the boundary that owns the
 * live gateway, verified confinement receipt and process-local auth authority. This function owns
 * the durable lifecycle around it: authority is attached before preparation, the binding is
 * returned only from the structured pre-attach callback, and every later failure tears down both
 * the structured session and the partially prepared host authority.
 */
export async function continuePreparedLocalLabWorkerStart(args: {
  prepared: PreparedLocalLabWorkerStart
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinatorHandle: string
  deps: LocalLabWorkerContinuationDeps
}): Promise<unknown> {
  const { prepared, runtime, db, run } = args
  const dispatchId = prepared.started.dispatch.id
  const task = prepared.started.task
  const custodyIdentity = Object.freeze({
    dispatchId,
    profileId: prepared.admission.profile
  })
  const resultContext = Object.freeze({
    runId: run.id,
    taskId: task.id,
    dispatchId,
    profile: prepared.admission.profile,
    adapter: prepared.admission.adapter
  })
  const runtimeResource = Object.freeze({ kind: 'created_lab_runtime', id: dispatchId })
  const effects: WorkerEffect[] = []
  let authority: PreparedLocalLabLaunchAuthority | undefined
  let structuredSession: Awaited<
    ReturnType<typeof createStructuredWorkerSessionForWorktree>
  > | null = null
  let preAttachIdentity: Readonly<StructuredWorkerIdentity> | undefined
  let launchReceipt: CodexLabLaunchReceiptV1 | undefined
  let failedStage = 'lab_authority_attach'
  try {
    db.planCodexLabRuntimeCustody({
      ...custodyIdentity,
      runtimeRoot: join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId)
    })
    const createSession =
      args.deps.createStructuredSession ?? createStructuredWorkerSessionForWorktree
    structuredSession = await createSession({
      runtime,
      db,
      worktreeId: prepared.worktree.id,
      dispatchId,
      agent: 'codex',
      launchMode: 'codex-lab',
      effects,
      beforeAttach: async (identity) => {
        preAttachIdentity = identity
        const terminalEffect: WorkerEffect = {
          kind: 'terminal',
          role: 'agent',
          action: 'created',
          id: identity.handle,
          surface: 'background'
        }
        const dispatchCapability = db.prepareStartingWorkerAuthority({
          dispatchId,
          handle: identity.handle,
          paneKey: identity.paneKey,
          processIncarnation: identity.processIncarnation,
          hostScope: JSON.stringify(identity.hostScope),
          worktreeId: prepared.worktree.id,
          effects: [runtimeResource, terminalEffect],
          setupState: 'not_applicable',
          preserveCreatedLabRuntimeResidual: true,
          terminalOwnership: 'created'
        })
        db.recordCodexLabRuntimeAuthorityAttached(custodyIdentity)
        failedStage = 'lab_host_prepare'
        const recorded = {
          layout: false,
          provider: false,
          gateway: false
        }
        const lifecycle: LocalLabLaunchLifecycleRecorder = Object.freeze({
          recordLayoutPrepared(evidence) {
            db.recordCodexLabRuntimeLayoutPrepared(evidence)
            recorded.layout = true
          },
          recordProviderReserved() {
            if (!recorded.layout) {
              throw new Error('Codex laboratory provider reservation preceded durable layout.')
            }
            db.recordCodexLabRuntimeProviderReserved({
              ...custodyIdentity,
              providerId: prepared.admission.adapter,
              sessionId: identity.sessionId,
              terminalHandle: identity.handle,
              terminalPaneKey: identity.paneKey,
              processIncarnation: identity.processIncarnation
            })
            recorded.provider = true
          },
          recordGatewayStarted(receipt) {
            if (!recorded.provider) {
              throw new Error('Codex laboratory gateway start preceded provider reservation.')
            }
            db.recordCodexLabRuntimeGatewayStarted({ ...custodyIdentity, receipt })
            recorded.gateway = true
          }
        })
        authority = await args.deps.prepareLaunchAuthority({
          prepared,
          identity,
          dispatchCapability,
          lifecycle
        })
        if (!recorded.layout || !recorded.provider || !recorded.gateway) {
          throw new Error('Codex laboratory launch authority skipped durable lifecycle evidence.')
        }
        failedStage = 'provider_attach'
        return { labLaunchBinding: authority.labLaunchBinding }
      }
    })

    const identity = structuredSession.identity
    const providerEvidence = Object.freeze({
      ...custodyIdentity,
      providerId: prepared.admission.adapter,
      sessionId: identity.sessionId,
      terminalHandle: identity.handle,
      terminalPaneKey: identity.paneKey,
      processIncarnation: identity.processIncarnation
    })
    // A successful structured attach includes process-local login and fresh-thread attestation.
    db.recordCodexLabRuntimeExternalAuthInstalled({
      ...custodyIdentity,
      authMethod: 'chatgptAuthTokens',
      authStorage: 'ephemeral',
      loginStartAccepted: true,
      authJsonAbsent: true
    })
    const attachedCustody = db.recordCodexLabRuntimeProviderAttached(providerEvidence)

    failedStage = 'launch_receipt'
    if (!authority) {
      throw new Error('Codex laboratory launch authority is missing after structured attach.')
    }
    launchReceipt = (args.deps.buildLaunchReceipt ?? buildCodexLabLaunchReceipt)({
      plan: authority.labLaunchBinding.plan,
      worktree: prepared.observation.receipt,
      hostReadiness: authority.hostReadinessReceipt,
      gateway: authority.gatewayReceipt,
      custody: attachedCustody,
      runtime: {
        runtimeId: runtime.getRuntimeId(),
        buildVersion: prepared.runtimeBuildVersion,
        capabilities: prepared.admittedRuntimeCapabilities
      }
    })
    db.recordCodexLabRuntimeLaunchReceipt({ ...custodyIdentity, receipt: launchReceipt })

    failedStage = 'dispatch_input'
    await (args.deps.deliverPreamble ?? deliverWorkerDispatchPreamble)({
      delivery: 'lab-structured-only',
      structuredSession,
      dispatchId,
      taskSpec: task.spec
    })
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: identity.handle,
      state: 'accepted'
    })
    const currentWorker = db.getWorkerDispatch(dispatchId)
    const alreadySettled = currentWorker && currentWorker.state !== 'starting'
    if (!alreadySettled) {
      db.recordCodexLabRuntimeReady(custodyIdentity)
    }
    const worker = alreadySettled
      ? currentWorker
      : db.markWorkerDispatchReady(dispatchId, [runtimeResource, ...effects])
    const workerOutcome =
      worker.stage === 'settled' && (worker.state === 'succeeded' || worker.state === 'failed')
        ? worker.state
        : undefined
    return readyLocalLabWorkerStartResult({
      context: resultContext,
      worker,
      workerOutcome,
      launchReceipt,
      alreadySettled: Boolean(alreadySettled),
      effects
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const cleanupErrors: string[] = []
    let unclaimedAuthorityReleased = false
    try {
      await (args.deps.tearDownFailedStart ?? tearDownFailedWorkerStart)({
        runtime,
        structuredSession,
        dispatchId
      })
    } catch (cleanupError) {
      cleanupErrors.push(
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      )
    }
    if (!structuredSession) {
      try {
        unclaimedAuthorityReleased = (await authority?.rollbackIfUnclaimed()) === true
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        )
      }
    }
    const cleanPreparationRefusal =
      failedStage === 'lab_host_prepare' &&
      !authority &&
      error instanceof LocalLabLaunchAuthorityPreparationRefusal &&
      error.cleanupProven
    if (preAttachIdentity && (cleanPreparationRefusal || unclaimedAuthorityReleased)) {
      try {
        db.releaseCodexLabPreAttachRuntimeCustody({
          ...custodyIdentity,
          terminalHandle: preAttachIdentity.handle,
          terminalPaneKey: preAttachIdentity.paneKey,
          processIncarnation: preAttachIdentity.processIncarnation
        })
        if (cleanPreparationRefusal) {
          error.releaseCleanupRegistration?.()
        } else {
          authority?.releaseCleanupRegistration()
        }
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        )
      }
    }
    const settledWorker = db.getWorkerDispatch(dispatchId)
    if (settledWorker && settledWorker.state !== 'starting') {
      const workerOutcome =
        settledWorker.stage === 'settled' &&
        (settledWorker.state === 'succeeded' || settledWorker.state === 'failed')
          ? settledWorker.state
          : undefined
      return settledLocalLabWorkerStartFailureResult({
        context: resultContext,
        worker: settledWorker,
        workerOutcome,
        lastError: reason,
        cleanupErrors,
        launchReceipt: db.getCodexLabRuntimeCustody(dispatchId)?.launchReceipt
      })
    }
    const failedWorker = db.failWorkerStart(dispatchId, failedStage, reason)
    if (authority && !unclaimedAuthorityReleased) {
      try {
        await reconcileExitedFailedLabProvider({ runtime, db, dispatchId })
      } catch (cleanupError) {
        cleanupErrors.push(
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        )
      }
    }
    const worker = db.getWorkerDispatch(dispatchId) ?? failedWorker
    return failedLocalLabWorkerStartResult({
      context: resultContext,
      worker,
      failedStage,
      lastError: reason,
      cleanupErrors,
      launchReceipt: db.getCodexLabRuntimeCustody(dispatchId)?.launchReceipt
    })
  }
}
