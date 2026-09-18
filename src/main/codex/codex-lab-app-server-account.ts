import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation-contract'
import type { CodexLabExternalChatGptLoginReceipt } from './codex-lab-external-chatgpt-auth-contract'
import { invalid, isAbsent, record, type ValidationFailure } from './codex-lab-app-server-value'

export type CodexLabAccountValidationResult =
  | Readonly<{
      ready: true
      capacityRoute: 'ordinary-included'
    }>
  | Readonly<{
      ready: false
      reason:
        | 'account_unverified'
        | 'paid_usage_forbidden'
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
  receipt: CodexLabExternalChatGptLoginReceipt
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
  return validateRateLimits(rateLimitsValue, expected.workspaceId, receipt.chatgptPlanType)
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
  planType: string
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
    return failed('paid_usage_forbidden', invalid('account/rateLimits/read.rateLimits.planType'))
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
