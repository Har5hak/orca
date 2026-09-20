import { createHash } from 'node:crypto'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { AgentSessionRecord } from '../../../../../../shared/agent-session-record'
import {
  agentSessionAccountHomeVariableForProvider,
  type AgentSessionAccountHomeVariable
} from '../../../../../../shared/agent-session-launch-constraints'
import type { AgentSessionHandleProvider } from '../../../../../../shared/agent-session-provider-handle'
import type { PreparedStructuredAgentSessionCreate } from '../../structured-agent-session-create'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from './worker-start-schema'

export const STRUCTURED_WRITE_PROFILE_ID = 'structured-write-v1' as const
export const STRUCTURED_WRITE_PROFILE_MAX_CONCURRENCY = 1 as const

export type WorkerStartExecutionProfileAdmission = Readonly<{
  id: typeof STRUCTURED_WRITE_PROFILE_ID
  maxConcurrency: typeof STRUCTURED_WRITE_PROFILE_MAX_CONCURRENCY
  agent: AgentSessionHandleProvider
  requiredPermissionPosture: 'manual'
  nestedWorkerStarts: 'forbidden'
}>

export type WorkerStartExecutionProfileValidation = Readonly<{
  id: typeof STRUCTURED_WRITE_PROFILE_ID
  maxConcurrency: typeof STRUCTURED_WRITE_PROFILE_MAX_CONCURRENCY
  provider: AgentSessionHandleProvider
  permissionPosture: {
    required: 'manual'
    enforcedAt: 'every-provider-acquisition'
  }
  worktree: { requested: 'new-child'; resolvedId: string }
  account: {
    route: 'selected-account-home'
    variable: AgentSessionAccountHomeVariable
    homeSha256: string
  }
  attachFingerprint: string
}>

export function resolveWorkerStartExecutionProfile(
  params: WorkerStartInput
): WorkerStartExecutionProfileAdmission | null {
  if (params.profile === undefined) {
    return null
  }
  if (params.profile !== STRUCTURED_WRITE_PROFILE_ID) {
    refuse('profile_unsupported', `Unsupported execution profile: ${params.profile}`)
  }
  if (params.agent !== 'codex') {
    refuse('provider_unsupported', `${STRUCTURED_WRITE_PROFILE_ID} currently requires Codex.`)
  }
  if (params.on !== undefined || params.terminal !== undefined) {
    refuse('execution_host_unsupported', `${STRUCTURED_WRITE_PROFILE_ID} runs locally only.`)
  }
  if (params.worktree !== 'new-child' || !params.name) {
    refuse(
      'worktree_selector_required',
      `${STRUCTURED_WRITE_PROFILE_ID} requires --worktree new-child and --name.`
    )
  }
  if (params.repo !== undefined) {
    refuse('cross_repo_forbidden', `${STRUCTURED_WRITE_PROFILE_ID} cannot change repositories.`)
  }
  if (params.setup !== 'skip') {
    refuse('setup_forbidden', `${STRUCTURED_WRITE_PROFILE_ID} requires --setup skip.`)
  }
  return Object.freeze({
    id: STRUCTURED_WRITE_PROFILE_ID,
    maxConcurrency: STRUCTURED_WRITE_PROFILE_MAX_CONCURRENCY,
    agent: 'codex',
    requiredPermissionPosture: 'manual',
    nestedWorkerStarts: 'forbidden'
  })
}

export function profileStartOptions(
  admission: WorkerStartExecutionProfileAdmission
): Readonly<Record<string, unknown>> {
  return {
    id: admission.id,
    maxConcurrency: admission.maxConcurrency,
    agent: admission.agent,
    permissionPosture: { required: admission.requiredPermissionPosture },
    nestedWorkerStarts: admission.nestedWorkerStarts,
    worktree: { requested: 'new-child' },
    setup: 'skip'
  }
}

export function assertWorkerExecutionProfileMode(
  admission: WorkerStartExecutionProfileAdmission,
  mode: { mode: 'structured' | 'terminal'; reason: string }
): void {
  if (mode.mode !== 'structured' || mode.reason !== 'execution_profile') {
    refuse(
      'structured_session_unavailable',
      `${admission.id} requires a host-supported structured chat session.`
    )
  }
}

export function validatePreparedWorkerExecutionProfile(args: {
  admission: WorkerStartExecutionProfileAdmission
  prepared: Pick<PreparedStructuredAgentSessionCreate, 'attachParams'>
  expectedWorktreeId: string
}): WorkerStartExecutionProfileValidation {
  const { attachParams } = args.prepared
  if (
    attachParams.provider !== args.admission.agent ||
    attachParams.agent !== args.admission.agent ||
    attachParams.requiredPermissionPosture !== 'manual' ||
    attachParams.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    attachParams.location.wslDistro !== null ||
    attachParams.location.workspaceKind !== 'git-worktree' ||
    attachParams.location.workspaceId !== args.expectedWorktreeId ||
    attachParams.accountHome.variable !==
      agentSessionAccountHomeVariableForProvider(args.admission.agent)
  ) {
    refuse(
      'profile_validation_failed',
      `${args.admission.id} could not validate its host-resolved launch.`
    )
  }
  const validation: WorkerStartExecutionProfileValidation = {
    id: args.admission.id,
    maxConcurrency: args.admission.maxConcurrency,
    provider: args.admission.agent,
    permissionPosture: {
      required: 'manual',
      enforcedAt: 'every-provider-acquisition'
    },
    worktree: { requested: 'new-child', resolvedId: args.expectedWorktreeId },
    account: {
      route: 'selected-account-home',
      variable: attachParams.accountHome.variable,
      homeSha256: createHash('sha256').update(attachParams.accountHome.path).digest('hex')
    },
    attachFingerprint: attachParams.envelope.payloadFingerprint
  }
  return Object.freeze(validation)
}

export function validatePersistedWorkerExecutionProfile(args: {
  admission: WorkerStartExecutionProfileAdmission
  validation: WorkerStartExecutionProfileValidation | undefined
  record: AgentSessionRecord | null | undefined
}): WorkerStartExecutionProfileValidation {
  if (
    !args.validation ||
    !args.record ||
    args.record.requiredPermissionPosture !== 'manual' ||
    args.record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    args.record.location.wslDistro !== null ||
    args.record.location.workspaceKind !== 'git-worktree' ||
    args.record.location.workspaceId !== args.validation.worktree.resolvedId ||
    args.record.provider !== args.admission.agent ||
    args.record.accountHome.variable !== args.validation.account.variable ||
    createHash('sha256').update(args.record.accountHome.path).digest('hex') !==
      args.validation.account.homeSha256
  ) {
    refuse(
      'profile_validation_failed',
      `${args.admission.id} did not persist its launch constraints.`
    )
  }
  return args.validation
}

function refuse(reason: string, message: string): never {
  throw new OrchestrationError('execution_profile_refused', message, { reason })
}
