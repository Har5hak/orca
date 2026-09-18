import type { Worktree } from '../../../../../../shared/worktree/types'
import { LAB_READONLY_PROFILE_RUNTIME_CAPABILITY } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import {
  collectVerifiedLabWorktreeObservation,
  type LabWorktreeIdentityRecord
} from '../../../../orchestration/lab-profile/lab-worktree-observation-collector'
import { createLocalLabWorktreeObservationCollectorDeps } from '../../../../orchestration/lab-profile/lab-worktree-observation-local-deps'
import type { VerifiedLabWorktreeObservation } from '../../../../orchestration/lab-profile/lab-worktree-observation'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import { parseTaskDeps } from './task-deps-argument'
import type { WorkerStartInput } from './worker-start-schema'
import type { LabWorkerStartAdmission } from './worker-start-profile-admission'
import type { RuntimeLabProfileReadiness } from '../../../../runtime-lab-profile-readiness'
import type { LocalLabWorkerStartContinuationContext } from './local-lab-worker-start-production'
import { createDefaultLocalLabWorkerStartContinuation } from './local-lab-worker-start-production-loader'

type WorkerStartMutation = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}

export type LocalLabWorkerStartReadiness = RuntimeLabProfileReadiness

export type PreparedLocalLabWorkerStart = Readonly<{
  started: ReturnType<OrchestrationDb['createStartingWorkerDispatch']>
  worktree: Worktree
  observation: VerifiedLabWorktreeObservation
  admission: LabWorkerStartAdmission
}>

export type LocalLabWorkerStartDeps = Readonly<{
  readReadiness: (
    runtime: OrcaRuntimeService,
    admission: LabWorkerStartAdmission
  ) => LocalLabWorkerStartReadiness
  observeWorktree: (args: {
    runtime: OrcaRuntimeService
    admission: LabWorkerStartAdmission
  }) => Promise<Readonly<{ worktree: Worktree; observation: VerifiedLabWorktreeObservation }>>
  requireStructuredCodex: (args: {
    runtime: OrcaRuntimeService
    worktree: Worktree
  }) => Promise<void>
  continuePreparedStart: (
    prepared: PreparedLocalLabWorkerStart,
    context: LocalLabWorkerStartContinuationContext
  ) => Promise<unknown>
}>

export async function startLocalLabWorker(args: {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  coordinatorPane: string | null
  existingTask?: TaskRow
  orchestrationMutation?: WorkerStartMutation
  admission: LabWorkerStartAdmission
  deps?: LocalLabWorkerStartDeps
}): Promise<unknown> {
  const {
    params,
    runtime,
    db,
    run,
    coordinatorPane,
    existingTask,
    orchestrationMutation,
    admission
  } = args
  const deps = args.deps ?? LOCAL_LAB_WORKER_START_DEPS

  const readiness = deps.readReadiness(runtime, admission)
  if (!readiness.ready) {
    refuse(
      'profile_runtime_unavailable',
      'The requested lab profile launch pipeline is not ready on this execution host.',
      { readiness: readiness.reason }
    )
  }
  if (
    !runtime
      .getStatus()
      .capabilities?.some((capability) => capability === LAB_READONLY_PROFILE_RUNTIME_CAPABILITY)
  ) {
    refuse(
      'profile_capability_unavailable',
      'This runtime no longer advertises the requested lab execution profile.'
    )
  }

  const creator = resolveDispatchCreator(runtime, params.from)
  if (db.resolveCreatorDepth(creator) !== 0) {
    refuse('nested_creator_forbidden', 'The lab profile accepts only a root conductor.')
  }

  const observed = await deps.observeWorktree({ runtime, admission })
  await deps.requireStructuredCodex({ runtime, worktree: observed.worktree })

  const startOptions = Object.freeze({
    profile: Object.freeze({
      id: admission.profile,
      adapter: admission.adapter,
      maxConcurrency: admission.maxConcurrency
    }),
    worktree: Object.freeze({
      id: observed.worktree.id,
      selector: observed.observation.observation.selector,
      identity: observed.observation.observation.worktreeIdentity,
      path: observed.observation.observation.realpath
    }),
    worktreeObservation: observed.observation.receipt,
    mode: Object.freeze({ requested: 'structured', effective: 'structured' }),
    agent: admission.agent
  })
  const started = db.createStartingWorkerDispatch({
    creator,
    maxDepth: runtime.getNestedWorkerMaxDepth(),
    taskId: existingTask?.id,
    taskSpec: params.spec,
    taskTitle: params.taskTitle,
    taskDeps: parseTaskDeps(params.deps),
    taskParentId: params.parent,
    taskRunId: run.id,
    taskCreatedByTerminalHandle: params.from,
    taskCreatedByPaneKey: coordinatorPane ?? undefined,
    taskCreatedByProcessIncarnation:
      runtime.getTerminalProcessIncarnation(params.from) ?? undefined,
    taskCreatedByRunGeneration: run.consumer_generation,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: orchestrationMutation,
    startOptions,
    profileLease: { profileId: admission.profile }
  })
  const labRuntimeResource = Object.freeze({
    kind: 'created_lab_runtime',
    id: started.dispatch.id
  })
  const worker = db.recordWorkerStage({
    dispatchId: started.dispatch.id,
    stage: 'lab_runtime_planned',
    effects: [labRuntimeResource],
    residualResources: [labRuntimeResource]
  })

  return deps.continuePreparedStart(
    Object.freeze({
      started: Object.freeze({ ...started, worker }),
      worktree: observed.worktree,
      observation: observed.observation,
      admission
    }),
    Object.freeze({ runtime, db, run, coordinatorHandle: params.from })
  )
}

export function readLocalLabWorkerStartReadiness(
  runtime: OrcaRuntimeService
): LocalLabWorkerStartReadiness {
  return runtime.readLabProfileReadiness()
}

async function observeLocalLabWorktree(args: {
  runtime: OrcaRuntimeService
  admission: LabWorkerStartAdmission
}): Promise<Readonly<{ worktree: Worktree; observation: VerifiedLabWorktreeObservation }>> {
  let resolvedWorktree: Worktree | undefined
  const deps = createLocalLabWorktreeObservationCollectorDeps(async (selector) => {
    let worktree: Worktree
    try {
      worktree = await args.runtime.showManagedTerminalWorkspace(selector)
    } catch {
      return []
    }
    resolvedWorktree = worktree
    return worktreeIdentityRecord(worktree)
  })
  const observation = await collectVerifiedLabWorktreeObservation({
    admission: args.admission,
    deps
  })
  if (!resolvedWorktree) {
    throw new Error('The verified lab worktree was not retained by the host resolver.')
  }
  return Object.freeze({ worktree: resolvedWorktree, observation })
}

function worktreeIdentityRecord(worktree: Worktree): readonly LabWorktreeIdentityRecord[] {
  if (!worktree.identity) {
    return []
  }
  return [
    Object.freeze({
      identity: worktree.identity.key,
      executionHostId: worktree.identity.executionHostId,
      kind: 'git-worktree',
      path: worktree.path
    })
  ]
}

async function requireStructuredCodex(args: {
  runtime: OrcaRuntimeService
  worktree: Worktree
}): Promise<void> {
  const support = await args.runtime.getStructuredAgentSessionCreateSupport(
    `id:${args.worktree.id}`,
    'codex'
  )
  if (!support.supported) {
    refuse(
      'structured_adapter_unavailable',
      'The lab profile requires structured Codex support and cannot downgrade to a terminal.'
    )
  }
}

const LOCAL_LAB_WORKER_START_DEPS: LocalLabWorkerStartDeps = Object.freeze({
  readReadiness: readLocalLabWorkerStartReadiness,
  observeWorktree: observeLocalLabWorktree,
  requireStructuredCodex,
  continuePreparedStart: createDefaultLocalLabWorkerStartContinuation()
})

function refuse(reason: string, message: string, extra?: Readonly<Record<string, string>>): never {
  throw new OrchestrationError('lab_profile_refused', message, {
    reason,
    effectsApplied: false,
    ...extra
  })
}
