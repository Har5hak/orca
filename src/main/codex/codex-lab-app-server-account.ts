import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation-contract'
import type { CodexLabExternalChatGptLoginReceipt } from './codex-lab-external-chatgpt-auth-contract'
import { invalid, isAbsent, record, type ValidationFailure } from './codex-lab-app-server-value'
import {
  CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE,
  CodexLabUsageAuthorizationError,
  assertCodexLabCapacityPolicy
} from '../runtime/orchestration/lab-profile/codex-lab-usage-authorization'

export type CodexLabAccountValidationResult =
  | Readonly<{
      ready: true
      capacityRoute: 'ordinary-included' | 'authorized-metered-workspace'
    }>
  | Readonly<{
      ready: false
      reason:
        | 'account_unverified'
        | 'paid_usage_forbidden'
        | 'metered_usage_authorization_expired'
        | 'ordinary_usage_blocked'
        | 'ordinary_usage_unavailable'
        | 'response_invalid'
      field: string
    }>

const CODEX_LAB_WORKSPACE_PLAN_TYPES = new Set([
  'team',
  'self_serve_business_prolite',
  'self_serve_business_usage_based',
  'business',
  'ent26',
  'enterprise_cbp_automation',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'edu_plus',
  'edu_pro'
])

const CODEX_LAB_USAGE_BASED_PLAN_TYPES = new Set([
  'self_serve_business_usage_based',
  'enterprise_cbp_usage_based'
])

export function isCodexLabWorkspacePlanType(value: unknown): value is string {
  return typeof value === 'string' && CODEX_LAB_WORKSPACE_PLAN_TYPES.has(value)
}

export function validateCodexLabAccount(
  value: unknown,
  rateLimitsValue: unknown,
  expected: CodexLabAppServerAttestationExpected,
  receipt: CodexLabExternalChatGptLoginReceipt,
  nowMs = Date.now()
): CodexLabAccountValidationResult {
  const receiptFailure = validateExternalAuthReceipt(receipt, expected.workspaceId)
  if (receiptFailure) {
    return failed('account_unverified', receiptFailure)
  }
  const response = knownRecord(value, ['account', 'requiresOpenaiAuth'])
  if (!response) {
    return failed('account_unverified', invalid('account/read'))
  }
  const account = knownRecord(response.account, ['type', 'email', 'planType'])
  if (!account || account.type !== 'chatgpt') {
    return failed('account_unverified', invalid('account/read.account.type'))
  }
  // `requiresOpenaiAuth` describes the selected provider's auth requirement; it
  // is true for the intended ChatGPT route even when that account is signed in.
  if (response.requiresOpenaiAuth !== true) {
    return failed('account_unverified', invalid('account/read.requiresOpenaiAuth'))
  }
  if (!isCodexLabWorkspacePlanType(account.planType)) {
    return failed('account_unverified', invalid('account/read.account.planType'))
  }
  if (account.planType !== receipt.chatgptPlanType) {
    return failed('account_unverified', invalid('account/read.account.planType'))
  }
  if (!isAbsent(account.email) && typeof account.email !== 'string') {
    return failed('account_unverified', invalid('account/read.account.email'))
  }
  return validateRateLimits(
    rateLimitsValue,
    expected.workspaceId,
    receipt.chatgptPlanType,
    expected,
    nowMs
  )
}

function validateExternalAuthReceipt(
  receipt: CodexLabExternalChatGptLoginReceipt,
  workspaceId: string
): ValidationFailure | null {
  const value = knownRecord(receipt, ['type', 'chatgptAccountId', 'chatgptPlanType'])
  if (
    !Object.isFrozen(receipt) ||
    value?.type !== 'chatgptAuthTokens' ||
    value.chatgptAccountId !== workspaceId ||
    !isCodexLabWorkspacePlanType(value.chatgptPlanType)
  ) {
    return invalid('externalAuthReceipt')
  }
  return null
}

function validateRateLimits(
  value: unknown,
  workspaceId: string,
  planType: string,
  expected: CodexLabAppServerAttestationExpected,
  nowMs: number
): CodexLabAccountValidationResult {
  const response = knownRecord(value, [
    'accountId',
    'ordinaryUsageAllowed',
    'rateLimitResetCredits',
    'rateLimitUpsell',
    'rateLimits',
    'rateLimitsByLimitId'
  ])
  if (!response) {
    return failed('account_unverified', invalid('account/rateLimits/read'))
  }
  if (response.accountId !== workspaceId) {
    return failed('account_unverified', invalid('account/rateLimits/read.accountId'))
  }
  const rateLimits = knownRecord(response.rateLimits, [
    'credits',
    'individualLimit',
    'limitId',
    'limitName',
    'normalModelSlug',
    'planType',
    'primary',
    'rateLimitReachedType',
    'secondary',
    'spendControlReached'
  ])
  if (!rateLimits) {
    return failed('account_unverified', invalid('account/rateLimits/read.rateLimits'))
  }
  if (!isCodexLabWorkspacePlanType(rateLimits.planType) || rateLimits.planType !== planType) {
    return failed('account_unverified', invalid('account/rateLimits/read.rateLimits.planType'))
  }
  if (CODEX_LAB_USAGE_BASED_PLAN_TYPES.has(planType)) {
    if (
      planType !== CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE ||
      expected.capacityPolicy.route !== 'authorized-metered-workspace' ||
      expected.capacityPolicy.planType !== planType
    ) {
      return failed('paid_usage_forbidden', invalid('account/rateLimits/read.rateLimits.planType'))
    }
    try {
      assertCodexLabCapacityPolicy({
        policy: expected.capacityPolicy,
        workspaceId,
        nowMs
      })
    } catch (error) {
      return error instanceof CodexLabUsageAuthorizationError &&
        error.reason === 'authorization_expired'
        ? failed(
            'metered_usage_authorization_expired',
            invalid('expected.capacityPolicy.expiresAt')
          )
        : failed('account_unverified', invalid('expected.capacityPolicy'))
    }
    return validateAuthorizedMeteredRateLimits(response, rateLimits, nowMs)
  }
  if (
    expected.capacityPolicy.route !== 'ordinary-included-only' ||
    expected.capacityPolicy.planType !== planType
  ) {
    return failed('account_unverified', invalid('expected.capacityPolicy'))
  }
  try {
    assertCodexLabCapacityPolicy({ policy: expected.capacityPolicy, workspaceId, nowMs })
  } catch {
    return failed('account_unverified', invalid('expected.capacityPolicy'))
  }
  if (response.ordinaryUsageAllowed === true) {
    return { ready: true, capacityRoute: 'ordinary-included' }
  }
  if (response.ordinaryUsageAllowed === false) {
    return failed('ordinary_usage_blocked', invalid('account/rateLimits/read.ordinaryUsageAllowed'))
  }
  if (response.ordinaryUsageAllowed === null) {
    return failed(
      'ordinary_usage_unavailable',
      invalid('account/rateLimits/read.ordinaryUsageAllowed')
    )
  }
  return failed('response_invalid', invalid('account/rateLimits/read.ordinaryUsageAllowed'))
}

function validateAuthorizedMeteredRateLimits(
  response: Record<string, unknown>,
  rateLimits: Record<string, unknown>,
  nowMs: number
): CodexLabAccountValidationResult {
  if (response.ordinaryUsageAllowed !== null) {
    return failed('response_invalid', invalid('account/rateLimits/read.ordinaryUsageAllowed'))
  }
  if (!isRateLimitResetCredits(response.rateLimitResetCredits)) {
    return failed('response_invalid', invalid('account/rateLimits/read.rateLimitResetCredits'))
  }
  const buckets = isAbsent(response.rateLimitsByLimitId)
    ? null
    : record(response.rateLimitsByLimitId)
  if (!isAbsent(response.rateLimitsByLimitId) && !buckets) {
    return failed('response_invalid', invalid('account/rateLimits/read.rateLimitsByLimitId'))
  }
  if (buckets && Object.hasOwn(buckets, 'codex')) {
    const bucket = knownRecord(buckets.codex, [
      'credits',
      'individualLimit',
      'limitId',
      'limitName',
      'normalModelSlug',
      'planType',
      'primary',
      'rateLimitReachedType',
      'secondary',
      'spendControlReached'
    ])
    if (!bucket) {
      return failed(
        'response_invalid',
        invalid('account/rateLimits/read.rateLimitsByLimitId.codex')
      )
    }
    const bucketResult = validateMeteredRateLimitSnapshot(
      bucket,
      nowMs,
      'account/rateLimits/read.rateLimitsByLimitId.codex'
    )
    if (!bucketResult.ready) {
      return bucketResult
    }
  }
  return validateMeteredRateLimitSnapshot(rateLimits, nowMs, 'account/rateLimits/read.rateLimits')
}

function validateMeteredRateLimitSnapshot(
  rateLimits: Record<string, unknown>,
  nowMs: number,
  field: string
): CodexLabAccountValidationResult {
  if (rateLimits.limitId !== 'codex') {
    return failed('response_invalid', invalid(`${field}.limitId`))
  }
  if (!isAbsent(rateLimits.limitName) && typeof rateLimits.limitName !== 'string') {
    return failed('response_invalid', invalid(`${field}.limitName`))
  }
  if (!isAbsent(rateLimits.normalModelSlug) && typeof rateLimits.normalModelSlug !== 'string') {
    return failed('response_invalid', invalid(`${field}.normalModelSlug`))
  }
  for (const window of ['primary', 'secondary'] as const) {
    if (!isRateLimitWindow(rateLimits[window])) {
      return failed('response_invalid', invalid(`${field}.${window}`))
    }
  }
  if (!isAbsent(rateLimits.rateLimitReachedType)) {
    return failed('ordinary_usage_blocked', invalid(`${field}.rateLimitReachedType`))
  }
  if (rateLimits.spendControlReached !== false) {
    return failed('ordinary_usage_blocked', invalid(`${field}.spendControlReached`))
  }
  if (rateLimits.planType !== CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE) {
    return failed('account_unverified', invalid(`${field}.planType`))
  }
  const credits = knownRecord(rateLimits.credits, ['balance', 'hasCredits', 'unlimited'])
  if (!credits) {
    return failed('response_invalid', invalid(`${field}.credits`))
  }
  if (credits.hasCredits !== true) {
    return failed('ordinary_usage_blocked', invalid(`${field}.credits.hasCredits`))
  }
  if (
    credits.unlimited !== false ||
    (!isAbsent(credits.balance) && typeof credits.balance !== 'string')
  ) {
    return failed('response_invalid', invalid(`${field}.credits`))
  }
  const individual = knownRecord(rateLimits.individualLimit, [
    'limit',
    'remainingPercent',
    'resetsAt',
    'used'
  ])
  if (!individual) {
    return failed('response_invalid', invalid(`${field}.individualLimit`))
  }
  const limit = canonicalNonnegativeDecimal(individual.limit)
  const used = canonicalNonnegativeDecimal(individual.used)
  if (
    limit === null ||
    used === null ||
    compareDecimals(limit, { coefficient: 0n, scale: 0 }) <= 0 ||
    compareDecimals(used, limit) >= 0
  ) {
    return failed('ordinary_usage_blocked', invalid(`${field}.individualLimit`))
  }
  if (
    typeof individual.remainingPercent !== 'number' ||
    !Number.isFinite(individual.remainingPercent) ||
    Number(individual.remainingPercent) < 1 ||
    Number(individual.remainingPercent) > 100
  ) {
    return failed('ordinary_usage_blocked', invalid(`${field}.individualLimit.remainingPercent`))
  }
  if (
    !Number.isInteger(individual.resetsAt) ||
    Number(individual.resetsAt) <= Math.floor(nowMs / 1_000)
  ) {
    return failed('ordinary_usage_blocked', invalid(`${field}.individualLimit.resetsAt`))
  }
  return { ready: true, capacityRoute: 'authorized-metered-workspace' }
}

function isRateLimitResetCredits(value: unknown): boolean {
  if (isAbsent(value)) {
    return true
  }
  const resetCredits = knownRecord(value, ['availableCount', 'credits'])
  if (!resetCredits) {
    return false
  }
  if (!Number.isInteger(resetCredits.availableCount) || Number(resetCredits.availableCount) < 0) {
    return false
  }
  if (resetCredits.credits === null) {
    return true
  }
  if (!Array.isArray(resetCredits.credits)) {
    return false
  }
  return resetCredits.credits.every((entry) => {
    const credit = knownRecord(entry, [
      'description',
      'expiresAt',
      'grantedAt',
      'id',
      'resetType',
      'status',
      'title'
    ])
    return (
      credit !== null &&
      typeof credit.id === 'string' &&
      ['codexRateLimits', 'unknown'].includes(String(credit.resetType)) &&
      ['available', 'redeeming', 'redeemed', 'unknown'].includes(String(credit.status)) &&
      typeof credit.grantedAt === 'number' &&
      Number.isFinite(credit.grantedAt) &&
      isOptionalTimestamp(credit.expiresAt) &&
      (isAbsent(credit.title) || typeof credit.title === 'string') &&
      (isAbsent(credit.description) || typeof credit.description === 'string')
    )
  })
}

function isRateLimitWindow(value: unknown): boolean {
  if (isAbsent(value)) {
    return true
  }
  const window = knownRecord(value, ['resetsAt', 'usedPercent', 'windowDurationMins'])
  return Boolean(
    window &&
    typeof window.usedPercent === 'number' &&
    Number.isFinite(window.usedPercent) &&
    (isAbsent(window.windowDurationMins) ||
      (typeof window.windowDurationMins === 'number' &&
        Number.isFinite(window.windowDurationMins))) &&
    (isAbsent(window.resetsAt) ||
      (typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)))
  )
}

function isOptionalTimestamp(value: unknown): boolean {
  return (
    isAbsent(value) ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value)))
  )
}

type CanonicalDecimal = Readonly<{ coefficient: bigint; scale: number }>

function canonicalNonnegativeDecimal(value: unknown): CanonicalDecimal | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    return null
  }
  try {
    const [whole, fraction = ''] = value.split('.')
    return {
      coefficient: BigInt(`${whole}${fraction}`),
      scale: fraction.length
    }
  } catch {
    return null
  }
}

function compareDecimals(left: CanonicalDecimal, right: CanonicalDecimal): number {
  const scale = Math.max(left.scale, right.scale)
  const leftValue = left.coefficient * 10n ** BigInt(scale - left.scale)
  const rightValue = right.coefficient * 10n ** BigInt(scale - right.scale)
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1
}

function failed(
  reason: Exclude<CodexLabAccountValidationResult, { ready: true }>['reason'],
  failure: ValidationFailure
): CodexLabAccountValidationResult {
  return { ready: false, reason, field: failure.field }
}

function knownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const object = record(value)
  if (!object || Object.keys(object).some((key) => !keys.includes(key))) {
    return null
  }
  return object
}
