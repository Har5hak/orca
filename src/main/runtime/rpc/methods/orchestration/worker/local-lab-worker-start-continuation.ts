import { join } from 'node:path'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow } from '../../../../orchestration/types'
import { CODEX_LAB_RUNTIME_ROOT } from '../../../../orchestration/lab-profile/codex-lab-launch-contract'
import type { CodexLabStructuredLaunchBinding } from '../../../../orchestration/lab-profile/codex-lab-structured-launch-binding-registry'
import type {
  CodexLabGatewayPublicReceipt,
  CodexLabRuntimeLayoutEvidence
} from '../../../../orchestration/db/lab-runtime-custody/lab-runtime-custody-contract'
import type { StructuredWorkerIdentity } from '../../../../structured-worker-identity'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
import { tearDownFailedWorkerStart } from './failed-worker-start-teardown'
import { createStructuredWorkerSessionForWorktree, type WorkerEffect } from './worker-topology'
import type { PreparedLocalLabWorkerStart } from './local-lab-worker-start'

export type PreparedLocalLabLaunchAuthority = Readonly<{
  labLaunchBinding: CodexLabStructuredLaunchBinding
  layoutEvidence: CodexLabRuntimeLayoutEvidence
  gatewayReceipt: CodexLabGatewayPublicReceipt
  /**
   * Releases resources only while no provider attachment has completed. Once attach returns, auth
   * remains in child-exit custody and cleanup must wait for the observed process exit.
   */
  /** Atomic: releases only unclaimed authority; a claimed provider remains exit-custodied. */
  rollbackIfUnclaimed: () => Promise<boolean>
}>

export type LocalLabWorkerContinuationDeps = Readonly<{
  prepareLaunchAuthority: (input: {
    prepared: PreparedLocalLabWorkerStart
    identity: Readonly<StructuredWorkerIdentity>
    dispatchCapability: string
  }) => Promise<PreparedLocalLabLaunchAuthority>
  createStructuredSession?: typeof createStructuredWorkerSessionForWorktree
  deliverPreamble?: typeof deliverWorkerDispatchPreamble
  tearDownFailedStart?: typeof tearDownFailedWorkerStart
}>

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
  const runtimeResource = Object.freeze({ kind: 'created_lab_runtime', id: dispatchId })
  const effects: WorkerEffect[] = []
  let authority: PreparedLocalLabLaunchAuthority | undefined
  let structuredSession: Awaited<
    ReturnType<typeof createStructuredWorkerSessionForWorktree>
  > | null = null
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
        authority = await args.deps.prepareLaunchAuthority({
          prepared,
          identity,
          dispatchCapability
        })
        db.recordCodexLabRuntimeLayoutPrepared(authority.layoutEvidence)
        db.recordCodexLabRuntimeProviderReserved({
          ...custodyIdentity,
          providerId: prepared.admission.adapter,
          sessionId: identity.sessionId,
          terminalHandle: identity.handle,
          terminalPaneKey: identity.paneKey,
          processIncarnation: identity.processIncarnation
        })
        db.recordCodexLabRuntimeGatewayStarted({
          ...custodyIdentity,
          receipt: authority.gatewayReceipt
        })
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
    db.recordCodexLabRuntimeProviderAttached(providerEvidence)

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
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId,
      state: workerOutcome ? 'ready' : worker.state,
      stage: worker.stage,
      ...(workerOutcome ? { workerOutcome } : {}),
      turnStart: 'observed',
      profile: prepared.admission.profile,
      adapter: prepared.admission.adapter,
      mode: { requested: 'structured', effective: 'structured' },
      effects: alreadySettled
        ? [
            ...(JSON.parse(worker.effects) as unknown[]),
            ...effects.filter((effect) => effect.kind === 'dispatch_input')
          ]
        : (JSON.parse(worker.effects) as unknown[]),
      residualResources: JSON.parse(worker.residual_resources) as unknown[]
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const cleanupErrors: string[] = []
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
        await authority?.rollbackIfUnclaimed()
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
      return {
        runId: run.id,
        taskId: task.id,
        dispatchId,
        state: workerOutcome ? 'ready' : settledWorker.state,
        stage: settledWorker.stage,
        ...(workerOutcome ? { workerOutcome } : {}),
        lastError: reason,
        ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
        profile: prepared.admission.profile,
        adapter: prepared.admission.adapter,
        mode: { requested: 'structured', effective: 'structured' },
        effects: JSON.parse(settledWorker.effects) as unknown[],
        residualResources: JSON.parse(settledWorker.residual_resources) as unknown[]
      }
    }
    const worker = db.failWorkerStart(dispatchId, failedStage, reason)
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId,
      state: worker.state,
      stage: worker.stage,
      failedStage,
      lastError: reason,
      ...(cleanupErrors.length > 0 ? { cleanupErrors } : {}),
      profile: prepared.admission.profile,
      adapter: prepared.admission.adapter,
      mode: { requested: 'structured', effective: 'structured' },
      effects: JSON.parse(worker.effects) as unknown[],
      residualResources: JSON.parse(worker.residual_resources) as unknown[]
    }
  }
}
