import { isAbsolute, normalize, parse, sep } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { canonicalWorktreeIdentity } from '../../../../../../shared/worktree/identity'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import {
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  resolveLabExecutionProfileAdapter,
  type LabExecutionProfileAdapter
} from './lab-execution-profile-registry'
import type { WorkerStartInput } from './worker-start-schema'

export const LAB_PROFILE_REFUSAL_CODE = 'lab_profile_refused' as const

export type LabProfileRefusalReason =
  | 'profile_request_incomplete'
  | 'profile_unsupported'
  | 'adapter_unsupported'
  | 'provider_unsupported'
  | 'selector_forbidden'
  | 'worktree_identity_invalid'
  | 'expected_path_invalid'

export type LabWorkerStartAdmission = LabExecutionProfileAdapter &
  Readonly<{
    worktreeIdentity: string
    worktreeInstanceId: string
    expectedWorktreePath: string
  }>

const PROFILE_INPUT_FIELDS = [
  'profile',
  'adapter',
  'worktreeIdentity',
  'expectedWorktreePath'
] as const

const FORBIDDEN_SELECTOR_FIELDS = [
  'worktree',
  'name',
  'repo',
  'baseBranch',
  'displayName',
  'comment',
  'setup',
  'on',
  'retryOf',
  'terminal'
] as const

export function resolveWorkerStartProfileAdmission(
  params: WorkerStartInput
): LabWorkerStartAdmission | null {
  if (PROFILE_INPUT_FIELDS.every((field) => params[field] === undefined)) {
    return null
  }
  const { profile, adapter: adapterId, worktreeIdentity, expectedWorktreePath } = params
  if (
    profile === undefined ||
    adapterId === undefined ||
    worktreeIdentity === undefined ||
    expectedWorktreePath === undefined
  ) {
    refuse('profile_request_incomplete', 'Profile admission requires all four profile inputs.')
  }
  if (profile !== LAB_READONLY_SUPERVISED_PROFILE_ID) {
    refuse('profile_unsupported', `Unsupported execution profile: ${profile}`)
  }

  const adapter = resolveLabExecutionProfileAdapter(profile, adapterId)
  if (!adapter) {
    refuse('adapter_unsupported', `Unsupported adapter for ${profile}: ${adapterId}`)
  }
  if (params.agent !== adapter.agent) {
    refuse(
      'provider_unsupported',
      `Execution profile ${profile} requires --agent ${adapter.agent}.`
    )
  }

  for (const field of FORBIDDEN_SELECTOR_FIELDS) {
    if (params[field] !== undefined) {
      refuse(
        'selector_forbidden',
        `Execution profile ${profile} does not accept --${toFlagName(field)}.`,
        field
      )
    }
  }

  const worktreeInstanceId = parseLocalCanonicalWorktreeIdentity(worktreeIdentity)
  if (!worktreeInstanceId) {
    refuse(
      'worktree_identity_invalid',
      '--worktree-identity must be a canonical local wt2:<executionHostId>:<instanceId> identity.'
    )
  }
  if (!isLexicallyExactAbsolutePath(expectedWorktreePath)) {
    refuse(
      'expected_path_invalid',
      '--expected-worktree-path must be an absolute, lexically normalized path without a trailing separator.'
    )
  }

  return Object.freeze({
    ...adapter,
    worktreeIdentity,
    worktreeInstanceId,
    expectedWorktreePath
  })
}

function parseLocalCanonicalWorktreeIdentity(value: string): string | null {
  const parts = value.split(':')
  if (parts.length !== 3 || parts[0] !== 'wt2' || !parts[1] || !parts[2]) {
    return null
  }
  try {
    const executionHostId = decodeURIComponent(parts[1])
    const instanceId = decodeURIComponent(parts[2])
    if (
      executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      instanceId.length === 0 ||
      canonicalWorktreeIdentity({ worktreeId: '', executionHostId, instanceId }) !== value
    ) {
      return null
    }
    return instanceId
  } catch {
    return null
  }
}

function isLexicallyExactAbsolutePath(value: string): boolean {
  const root = parse(value).root
  return (
    value.length > root.length &&
    value === value.trim() &&
    !value.includes('\u0000') &&
    isAbsolute(value) &&
    normalize(value) === value &&
    !value.endsWith(sep)
  )
}

function toFlagName(field: string): string {
  return field.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
}

function refuse(reason: LabProfileRefusalReason, message: string, field?: string): never {
  throw new OrchestrationError(
    LAB_PROFILE_REFUSAL_CODE,
    message,
    field === undefined ? { reason } : { reason, field }
  )
}
