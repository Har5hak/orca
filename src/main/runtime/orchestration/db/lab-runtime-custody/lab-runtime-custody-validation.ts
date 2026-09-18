import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  CODEX_LAB_RUNTIME_ROOT,
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID
} from '../../lab-profile/codex-lab-launch-contract'
import { isGeneratedId } from '../generated-id'
import type {
  CodexLabRuntimeCleanupReasonCode,
  CodexLabRuntimeCleanupResult,
  CodexLabRuntimeCustodyIdentity,
  CodexLabRuntimeExternalAuthEvidence,
  CodexLabRuntimeLayoutEvidence,
  CodexLabRuntimePathIdentity,
  CodexLabRuntimeProviderCommitments,
  CodexLabRuntimeProviderEvidence,
  PlanCodexLabRuntimeCustodyInput
} from './lab-runtime-custody-contract'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const DECIMAL_IDENTITY_PATTERN = /^(?:0|[1-9][0-9]{0,31})$/u
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu
const STRUCTURED_HANDLE_PATTERN = /^structworker_[a-f0-9-]{36}$/iu
const STRUCTURED_INCARNATION_PATTERN = /^structured:[a-f0-9-]{36}$/iu

export function normalizeCodexLabCustodyIdentity(input: unknown): CodexLabRuntimeCustodyIdentity {
  const object = requireExactDataObject(input, 'identity', ['dispatchId', 'profileId'])
  const dispatchId = requireStringValue(object.dispatchId, 'Dispatch id')
  const profileId = requireStringValue(object.profileId, 'profile id')
  requireCodexLabCustodyIdentityParts(dispatchId, profileId)
  return Object.freeze({ dispatchId, profileId })
}

export function requireCodexLabCustodyIdentityParts(dispatchId: string, profileId: string): void {
  if (!isGeneratedId(dispatchId, 'ctx')) {
    throw new Error('Codex laboratory runtime custody requires a generated Dispatch id.')
  }
  if (profileId !== LAB_READONLY_SUPERVISED_PROFILE_ID) {
    throw new Error('Codex laboratory runtime custody profile does not match the sealed profile.')
  }
}

export function normalizeCodexLabPlanInput(input: unknown): PlanCodexLabRuntimeCustodyInput {
  const object = requireExactDataObject(input, 'plan', ['dispatchId', 'profileId', 'runtimeRoot'])
  const dispatchId = requireStringValue(object.dispatchId, 'Dispatch id')
  const profileId = requireStringValue(object.profileId, 'profile id')
  const runtimeRoot = requireStringValue(object.runtimeRoot, 'runtime root')
  requireCodexLabCustodyIdentityParts(dispatchId, profileId)
  requireCodexLabRuntimeRoot(dispatchId, runtimeRoot)
  return Object.freeze({ dispatchId, profileId, runtimeRoot })
}

export function expectedCodexLabDispatchRuntimeRoot(dispatchId: string): string {
  if (!isGeneratedId(dispatchId, 'ctx')) {
    throw new Error('Codex laboratory runtime custody requires a generated Dispatch id.')
  }
  return join(CODEX_LAB_RUNTIME_ROOT, 'dispatches', dispatchId)
}

export function requireCodexLabRuntimeRoot(dispatchId: string, runtimeRoot: string): void {
  if (runtimeRoot !== expectedCodexLabDispatchRuntimeRoot(dispatchId)) {
    throw new Error('Codex laboratory runtime custody root does not match its Dispatch.')
  }
}

export function normalizeCodexLabPathIdentity(
  identity: unknown,
  field: string
): CodexLabRuntimePathIdentity {
  const object = requireExactDataObject(identity, field, ['device', 'inode'])
  return Object.freeze({
    device: requireDecimalIdentity(object.device, `${field}.device`),
    inode: requireDecimalIdentity(object.inode, `${field}.inode`)
  })
}

export function requireSha256(value: string, field: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} must be a SHA-256 digest.`)
  }
  return value
}

export function normalizeCodexLabLayoutEvidence(input: unknown): CodexLabRuntimeLayoutEvidence {
  const object = requireExactDataObject(input, 'layout evidence', [
    'dispatchId',
    'profileId',
    'runtimeParentIdentity',
    'runtimeRootIdentity',
    'configSha256'
  ])
  const identity = identityFromSnapshot(object)
  return Object.freeze({
    ...identity,
    runtimeParentIdentity: normalizeCodexLabPathIdentity(
      object.runtimeParentIdentity,
      'runtime parent identity'
    ),
    runtimeRootIdentity: normalizeCodexLabPathIdentity(
      object.runtimeRootIdentity,
      'runtime root identity'
    ),
    configSha256: requireSha256Value(object.configSha256, 'config digest')
  })
}

export function normalizeCodexLabExternalAuthEvidence(
  input: unknown
): CodexLabRuntimeExternalAuthEvidence {
  const object = requireExactDataObject(input, 'external auth evidence', [
    'dispatchId',
    'profileId',
    'authMethod',
    'authStorage',
    'loginStartAccepted',
    'authJsonAbsent'
  ])
  const identity = identityFromSnapshot(object)
  if (
    object.authMethod !== 'chatgptAuthTokens' ||
    object.authStorage !== 'ephemeral' ||
    object.loginStartAccepted !== true ||
    object.authJsonAbsent !== true
  ) {
    throw new Error('Codex laboratory runtime external auth evidence is incomplete.')
  }
  return Object.freeze({
    ...identity,
    authMethod: 'chatgptAuthTokens',
    authStorage: 'ephemeral',
    loginStartAccepted: true,
    authJsonAbsent: true
  })
}

export function normalizeCodexLabProviderEvidence(input: unknown): CodexLabRuntimeProviderEvidence {
  const object = requireExactDataObject(input, 'provider evidence', [
    'dispatchId',
    'profileId',
    'providerId',
    'sessionId',
    'terminalHandle',
    'terminalPaneKey',
    'processIncarnation'
  ])
  const identity = identityFromSnapshot(object)
  const providerId = requireStringValue(object.providerId, 'provider id')
  const sessionId = requireStringValue(object.sessionId, 'provider session')
  const terminalHandle = requireStringValue(object.terminalHandle, 'terminal handle')
  const terminalPaneKey = requireStringValue(object.terminalPaneKey, 'terminal pane key')
  const processIncarnation = requireStringValue(object.processIncarnation, 'process incarnation')
  if (
    providerId !== CODEX_WORKSPACE_CHATGPT_ADAPTER_ID ||
    !UUID_PATTERN.test(sessionId) ||
    !STRUCTURED_HANDLE_PATTERN.test(terminalHandle) ||
    !SAFE_LABEL_PATTERN.test(terminalPaneKey) ||
    !STRUCTURED_INCARNATION_PATTERN.test(processIncarnation) ||
    processIncarnation !== `structured:${sessionId}`
  ) {
    throw new Error('Codex laboratory runtime provider identity is invalid.')
  }
  return Object.freeze({
    ...identity,
    providerId: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    sessionId,
    terminalHandle,
    terminalPaneKey,
    processIncarnation
  })
}

export function codexLabProviderCommitments(input: unknown): CodexLabRuntimeProviderCommitments {
  const evidence = normalizeCodexLabProviderEvidence(input)
  return Object.freeze({
    id: evidence.providerId,
    sessionSha256: sha256(evidence.sessionId),
    terminalHandleSha256: sha256(evidence.terminalHandle),
    terminalPaneKeySha256: sha256(evidence.terminalPaneKey),
    processIncarnationSha256: sha256(evidence.processIncarnation)
  })
}

export function normalizeCodexLabCleanupResult(input: unknown): CodexLabRuntimeCleanupResult {
  const object = requireExactDataObject(
    input,
    'cleanup result',
    ['dispatchId', 'profileId', 'resource', 'outcome'],
    ['reasonCode', 'detailSha256']
  )
  const identity = identityFromSnapshot(object)
  const resource = requireCleanupResource(object.resource)
  const outcome = requireCleanupOutcome(object.outcome)
  const reasonCode =
    object.reasonCode === undefined ? undefined : requireCleanupReasonCode(object.reasonCode)
  const detailSha256 =
    object.detailSha256 === undefined
      ? undefined
      : requireSha256Value(object.detailSha256, 'cleanup detail digest')
  if (
    outcome === 'released' ? reasonCode !== undefined || detailSha256 !== undefined : !reasonCode
  ) {
    throw new Error(
      'Codex laboratory runtime cleanup reason codes must describe only unresolved work.'
    )
  }
  return Object.freeze({
    ...identity,
    resource,
    outcome,
    ...(reasonCode ? { reasonCode } : {}),
    ...(detailSha256 ? { detailSha256 } : {})
  })
}

function requireExactDataObject(
  value: unknown,
  field: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} must be an object.`)
  }
  const keys = Reflect.ownKeys(value)
  const allowedKeys = [...requiredKeys, ...optionalKeys]
  if (
    keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !keys.includes(key)) ||
    keys.length < requiredKeys.length ||
    keys.length > allowedKeys.length
  ) {
    throw new Error(`Codex laboratory runtime custody ${field} fields are invalid.`)
  }
  const snapshot: Record<string, unknown> = {}
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new Error(`Codex laboratory runtime custody ${field} fields are invalid.`)
    }
    snapshot[key] = requireDataField(value, key, field)
  }
  return Object.freeze(snapshot)
}

function identityFromSnapshot(
  object: Readonly<Record<string, unknown>>
): CodexLabRuntimeCustodyIdentity {
  const dispatchId = requireStringValue(object.dispatchId, 'Dispatch id')
  const profileId = requireStringValue(object.profileId, 'profile id')
  requireCodexLabCustodyIdentityParts(dispatchId, profileId)
  return Object.freeze({ dispatchId, profileId })
}

function requireDataField(value: object, key: string, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
    throw new Error(`Codex laboratory runtime custody ${field} must use data fields.`)
  }
  return descriptor.value
}

export function requireDecimalIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !DECIMAL_IDENTITY_PATTERN.test(value)) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  return value
}

export function requireSha256Value(value: unknown, field: string): string {
  return requireSha256(requireStringValue(value, field), field)
}

export function requireStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  return value
}

export function requireLiteral<T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) {
    throw new Error(`Codex laboratory runtime custody ${field} is invalid.`)
  }
  return expected
}

function requireCleanupResource(value: unknown) {
  if (value !== 'layout' && value !== 'auth' && value !== 'gateway' && value !== 'provider') {
    throw new Error('Codex laboratory runtime cleanup resource is invalid.')
  }
  return value
}

function requireCleanupOutcome(value: unknown) {
  if (value !== 'released' && value !== 'failed' && value !== 'unproven') {
    throw new Error('Codex laboratory runtime cleanup outcome is invalid.')
  }
  return value
}

function requireCleanupReasonCode(value: unknown): CodexLabRuntimeCleanupReasonCode {
  if (
    value !== 'release_failed' &&
    value !== 'identity_unproven' &&
    value !== 'process_exit_unproven' &&
    value !== 'host_unreachable' &&
    value !== 'resource_busy' &&
    value !== 'unexpected_error'
  ) {
    throw new Error('Codex laboratory runtime cleanup reason code is invalid.')
  }
  return value
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
