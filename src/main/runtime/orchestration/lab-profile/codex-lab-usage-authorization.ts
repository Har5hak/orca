import { createHash } from 'node:crypto'

export const CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE = 'enterprise_cbp_usage_based' as const

export type CodexLabUsageAuthorizationV1 = Readonly<{
  schemaVersion: 1
  workspaceIdSha256: string
  planType: typeof CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE
  expiresAt: string
}>

export type CodexLabCapacityPolicy = Readonly<{
  route: 'ordinary-included-only' | 'authorized-metered-workspace'
  workspaceIdSha256: string
  planType: string
  expiresAt: string
}>

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const AUTHORIZATION_KEYS = ['expiresAt', 'planType', 'schemaVersion', 'workspaceIdSha256']

export class CodexLabUsageAuthorizationError extends Error {
  constructor(
    readonly reason: 'authorization_invalid' | 'authorization_expired' | 'plan_not_authorizable'
  ) {
    super(`Codex laboratory usage authorization refused: ${reason}`)
    this.name = 'CodexLabUsageAuthorizationError'
  }
}

export function mintCodexLabUsageAuthorization(input: {
  workspaceId: string
  planType: string
  expiresAt: string
  nowMs?: number
}): CodexLabUsageAuthorizationV1 {
  if (input.planType !== CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE) {
    throw new CodexLabUsageAuthorizationError('plan_not_authorizable')
  }
  const expiresAt = canonicalFutureInstant(input.expiresAt, input.nowMs ?? Date.now())
  return Object.freeze({
    schemaVersion: 1,
    workspaceIdSha256: sha256(input.workspaceId),
    planType: CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE,
    expiresAt
  })
}

export function serializeCodexLabUsageAuthorization(
  authorization: CodexLabUsageAuthorizationV1
): string {
  assertCodexLabUsageAuthorization(authorization)
  return JSON.stringify(authorization)
}

export function parseCodexLabUsageAuthorization(
  serialized: string | null | undefined
): CodexLabUsageAuthorizationV1 | null {
  if (serialized === null || serialized === undefined) {
    return null
  }
  let candidate: unknown
  try {
    candidate = JSON.parse(serialized)
  } catch {
    throw new CodexLabUsageAuthorizationError('authorization_invalid')
  }
  assertCodexLabUsageAuthorization(candidate)
  return Object.freeze({
    schemaVersion: candidate.schemaVersion,
    workspaceIdSha256: candidate.workspaceIdSha256,
    planType: candidate.planType,
    expiresAt: candidate.expiresAt
  })
}

export function assertCodexLabUsageAuthorization(
  candidate: unknown
): asserts candidate is CodexLabUsageAuthorizationV1 {
  if (!isRecord(candidate) || !sameStrings(Object.keys(candidate).sort(), AUTHORIZATION_KEYS)) {
    throw new CodexLabUsageAuthorizationError('authorization_invalid')
  }
  if (
    candidate.schemaVersion !== 1 ||
    !SHA256_PATTERN.test(String(candidate.workspaceIdSha256)) ||
    candidate.planType !== CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE ||
    canonicalInstant(candidate.expiresAt) === null
  ) {
    throw new CodexLabUsageAuthorizationError('authorization_invalid')
  }
}

export function requireCurrentCodexLabUsageAuthorization(input: {
  authorization: CodexLabUsageAuthorizationV1 | null
  workspaceId: string
  planType: string
  nowMs?: number
}): CodexLabUsageAuthorizationV1 {
  const authorization = input.authorization
  if (
    !authorization ||
    authorization.workspaceIdSha256 !== sha256(input.workspaceId) ||
    authorization.planType !== input.planType
  ) {
    throw new CodexLabUsageAuthorizationError('authorization_invalid')
  }
  if (Date.parse(authorization.expiresAt) <= (input.nowMs ?? Date.now())) {
    throw new CodexLabUsageAuthorizationError('authorization_expired')
  }
  return authorization
}

export function codexLabCapacityPolicy(input: {
  workspaceId: string
  planType: string
  authorization: CodexLabUsageAuthorizationV1 | null
  nowMs?: number
}): CodexLabCapacityPolicy {
  if (input.planType !== CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE || input.authorization === null) {
    return Object.freeze({
      route: 'ordinary-included-only',
      workspaceIdSha256: sha256(input.workspaceId),
      planType: input.planType,
      expiresAt: ''
    })
  }
  const authorization = requireCurrentCodexLabUsageAuthorization(input)
  return Object.freeze({
    route: 'authorized-metered-workspace',
    workspaceIdSha256: authorization.workspaceIdSha256,
    planType: authorization.planType,
    expiresAt: authorization.expiresAt
  })
}

export function assertCodexLabCapacityPolicy(input: {
  policy: CodexLabCapacityPolicy
  workspaceId: string
  nowMs?: number
}): void {
  const { policy } = input
  if (
    !Object.isFrozen(policy) ||
    policy.workspaceIdSha256 !== sha256(input.workspaceId) ||
    !policy.planType
  ) {
    throw new CodexLabUsageAuthorizationError('authorization_invalid')
  }
  if (policy.route === 'ordinary-included-only') {
    if (policy.expiresAt !== '' || policy.planType === CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE) {
      throw new CodexLabUsageAuthorizationError('authorization_invalid')
    }
    return
  }
  if (
    policy.route !== 'authorized-metered-workspace' ||
    policy.planType !== CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE ||
    canonicalInstant(policy.expiresAt) === null
  ) {
    throw new CodexLabUsageAuthorizationError('authorization_invalid')
  }
  if (Date.parse(policy.expiresAt) <= (input.nowMs ?? Date.now())) {
    throw new CodexLabUsageAuthorizationError('authorization_expired')
  }
}

export function codexLabCapacityPolicySha256(policy: CodexLabCapacityPolicy): string {
  return sha256(JSON.stringify(policy))
}

function canonicalFutureInstant(value: string, nowMs: number): string {
  const canonical = canonicalInstant(value)
  if (canonical === null) {
    throw new CodexLabUsageAuthorizationError('authorization_invalid')
  }
  if (Date.parse(canonical) <= nowMs) {
    throw new CodexLabUsageAuthorizationError('authorization_expired')
  }
  return canonical
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    return null
  }
  const canonical = new Date(milliseconds).toISOString()
  return canonical === value ? canonical : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
