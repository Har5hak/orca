import type { CodexLabAppServerAttestationExpected } from './codex-lab-app-server-attestation-contract'
import { invalid, isAbsent, record, type ValidationFailure } from './codex-lab-app-server-value'

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

export function validateCodexLabAccount(
  value: unknown,
  expected: CodexLabAppServerAttestationExpected
): ValidationFailure | null {
  const response = knownRecord(value, ['account', 'requiresOpenaiAuth', 'workspaceRouting'])
  if (!response) {
    return invalid('account/read')
  }
  const account = knownRecord(response.account, ['type', 'email', 'planType'])
  if (!account || account.type !== 'chatgpt') {
    return invalid('account/read.account.type')
  }
  // `requiresOpenaiAuth` describes the selected provider's auth requirement; it
  // is true for the intended ChatGPT route even when that account is signed in.
  if (response.requiresOpenaiAuth !== true) {
    return invalid('account/read.requiresOpenaiAuth')
  }
  if (!CODEX_LAB_WORKSPACE_PLAN_TYPES.has(String(account.planType))) {
    return invalid('account/read.account.planType')
  }
  if (!isAbsent(account.email) && typeof account.email !== 'string') {
    return invalid('account/read.account.email')
  }
  return validateWorkspaceRouting(response.workspaceRouting, expected.workspaceId)
}

function validateWorkspaceRouting(value: unknown, workspaceId: string): ValidationFailure | null {
  const routing = knownRecord(value, [
    'chatgptAccountId',
    'backendOrigin',
    'accountRoutingOverride'
  ])
  if (routing?.chatgptAccountId !== workspaceId || !isHttpsOrigin(routing.backendOrigin)) {
    return invalid('account/read.workspaceRouting')
  }
  if (!['NO_CONSTRAINT', 'us', 'us_cr'].includes(String(routing.accountRoutingOverride))) {
    return invalid('account/read.workspaceRouting.accountRoutingOverride')
  }
  return null
}

function isHttpsOrigin(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

function knownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const object = record(value)
  if (!object || Object.keys(object).some((key) => !keys.includes(key))) {
    return null
  }
  return object
}
