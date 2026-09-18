import { isCodexLabWorkspacePlanType } from './codex-lab-app-server-account'
import {
  refuseCodexLabExternalChatGptAuth,
  type CodexLabExternalChatGptAuthBinding,
  type CodexLabExternalChatGptCredentialState,
  type CodexLabExternalChatGptLoginParams,
  type CodexLabExternalChatGptRefreshRequest,
  type CodexLabExternalChatGptRefreshResult
} from './codex-lab-external-chatgpt-auth-contract'

const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u
const MAX_TOKEN_LENGTH = 64 * 1024
const MINIMUM_TOKEN_LIFETIME_MS = 30_000

export function snapshotCodexLabExternalChatGptAuthBinding(
  candidate: unknown
): CodexLabExternalChatGptAuthBinding {
  const fields = exactOwnDataRecord(candidate, ['dispatchId', 'sessionId', 'workspaceId'])
  if (
    !fields ||
    !validDispatchId(fields.dispatchId) ||
    !validSessionId(fields.sessionId) ||
    typeof fields.workspaceId !== 'string' ||
    !WORKSPACE_ID_PATTERN.test(fields.workspaceId)
  ) {
    throw refuseCodexLabExternalChatGptAuth('binding_invalid')
  }
  return Object.freeze({
    dispatchId: fields.dispatchId,
    sessionId: fields.sessionId,
    workspaceId: fields.workspaceId
  })
}

export function snapshotCodexLabExternalChatGptInitialCredential(
  candidate: unknown,
  binding: CodexLabExternalChatGptAuthBinding
): CodexLabExternalChatGptCredentialState {
  const fields = exactOwnDataRecord(candidate, [
    'type',
    'accessToken',
    'chatgptAccountId',
    'chatgptPlanType'
  ])
  if (fields?.type !== 'chatgptAuthTokens') {
    throw refuseCodexLabExternalChatGptAuth('credential_invalid')
  }
  return snapshotCredentialFields(fields, binding)
}

export function snapshotCodexLabExternalChatGptRefreshCredential(
  candidate: unknown,
  binding: CodexLabExternalChatGptAuthBinding,
  expectedPlanType: string
): CodexLabExternalChatGptCredentialState {
  const fields = exactOwnDataRecord(candidate, [
    'accessToken',
    'chatgptAccountId',
    'chatgptPlanType'
  ])
  const credential = snapshotCredentialFields(fields, binding)
  if (credential.chatgptPlanType !== expectedPlanType) {
    throw refuseCodexLabExternalChatGptAuth('credential_invalid')
  }
  return credential
}

export function assertCodexLabExternalChatGptRefreshRequest(
  candidate: unknown,
  binding: CodexLabExternalChatGptAuthBinding
): asserts candidate is CodexLabExternalChatGptRefreshRequest {
  const fields = exactOwnDataRecord(candidate, ['reason', 'previousAccountId'])
  if (fields?.reason !== 'unauthorized' || fields.previousAccountId !== binding.workspaceId) {
    throw refuseCodexLabExternalChatGptAuth('refresh_request_invalid')
  }
}

export function freezeCodexLabExternalChatGptLoginParams(
  credential: CodexLabExternalChatGptCredentialState
): CodexLabExternalChatGptLoginParams {
  return Object.freeze({
    type: credential.type,
    accessToken: credential.accessToken,
    chatgptAccountId: credential.chatgptAccountId,
    chatgptPlanType: credential.chatgptPlanType
  })
}

export function freezeCodexLabExternalChatGptRefreshResult(
  credential: CodexLabExternalChatGptCredentialState
): CodexLabExternalChatGptRefreshResult {
  return Object.freeze({
    accessToken: credential.accessToken,
    chatgptAccountId: credential.chatgptAccountId,
    chatgptPlanType: credential.chatgptPlanType
  })
}

export function assertCodexLabExternalChatGptCredentialFresh(
  credential: CodexLabExternalChatGptCredentialState
): void {
  if (!isFreshJwt(credential.accessToken)) {
    throw refuseCodexLabExternalChatGptAuth('credential_not_fresh')
  }
}

export function sameCodexLabExternalChatGptAuthBinding(
  actual: CodexLabExternalChatGptAuthBinding | undefined,
  expected: CodexLabExternalChatGptAuthBinding
): boolean {
  return (
    actual?.dispatchId === expected.dispatchId &&
    actual.sessionId === expected.sessionId &&
    actual.workspaceId === expected.workspaceId
  )
}

export function exactCodexLabExternalChatGptOwnDataRecord(
  candidate: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  const fields = exactOwnDataRecordWithExtras(candidate)
  if (!fields) {
    return null
  }
  const keys = Object.keys(fields).sort()
  const expected = [...expectedKeys].sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    ? fields
    : null
}

function snapshotCredentialFields(
  fields: Readonly<Record<string, unknown>> | null,
  binding: CodexLabExternalChatGptAuthBinding
): CodexLabExternalChatGptCredentialState {
  if (
    !fields ||
    typeof fields.accessToken !== 'string' ||
    fields.accessToken.length === 0 ||
    fields.accessToken.length > MAX_TOKEN_LENGTH ||
    fields.chatgptAccountId !== binding.workspaceId ||
    !isCodexLabWorkspacePlanType(fields.chatgptPlanType)
  ) {
    throw refuseCodexLabExternalChatGptAuth('credential_invalid')
  }
  const credential = Object.freeze({
    type: 'chatgptAuthTokens',
    accessToken: fields.accessToken,
    chatgptAccountId: binding.workspaceId,
    chatgptPlanType: fields.chatgptPlanType
  })
  assertCodexLabExternalChatGptCredentialFresh(credential)
  return credential
}

function isFreshJwt(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !part || !JWT_SEGMENT_PATTERN.test(part))) {
    return false
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const fields = exactOwnDataRecordWithExtras(payload)
    const expiresAtSeconds = fields?.exp
    return (
      typeof expiresAtSeconds === 'number' &&
      Number.isSafeInteger(expiresAtSeconds) &&
      expiresAtSeconds * 1_000 > Date.now() + MINIMUM_TOKEN_LIFETIME_MS
    )
  } catch {
    return false
  }
}

function exactOwnDataRecord(
  candidate: unknown,
  expectedKeys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  return exactCodexLabExternalChatGptOwnDataRecord(candidate, expectedKeys)
}

function exactOwnDataRecordWithExtras(
  candidate: unknown
): Readonly<Record<string, unknown>> | null {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return null
  }
  try {
    const prototype = Object.getPrototypeOf(candidate)
    if (prototype !== Object.prototype && prototype !== null) {
      return null
    }
    const keys = Reflect.ownKeys(candidate)
    if (keys.some((key) => typeof key !== 'string')) {
      return null
    }
    const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return null
      }
      fields[key] = descriptor.value
    }
    return fields
  } catch {
    return null
  }
}

function validDispatchId(value: unknown): value is string {
  return (
    typeof value === 'string' && value !== '.' && value !== '..' && DISPATCH_ID_PATTERN.test(value)
  )
}

function validSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' && value !== '.' && value !== '..' && SESSION_ID_PATTERN.test(value)
  )
}
