import { createHash, timingSafeEqual } from 'node:crypto'
import { isAbsolute, join, normalize, parse } from 'node:path'
import { readCodexAuthIdentity } from '../codex-accounts/codex-auth-identity'
import { CODEX_LAB_RUNTIME_ROOT } from '../runtime/orchestration/lab-profile/codex-lab-launch-contract'

export const CODEX_AUTH_KEYRING_SERVICE = 'Codex Auth' as const
export const CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE =
  'ORCA_CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSED' as const

export type CodexLabCredentialMaterializationRefusalReason =
  | 'auth_method_unsupported'
  | 'credential_incomplete'
  | 'expectation_invalid'
  | 'materialization_failed'
  | 'plan_mismatch'
  | 'source_invalid'
  | 'source_missing'
  | 'source_read_failed'
  | 'target_cleanup_failed'
  | 'target_home_invalid'
  | 'target_read_failed'
  | 'target_readback_mismatch'
  | 'target_write_failed'
  | 'workspace_mismatch'

export class CodexLabCredentialMaterializationRefusal extends Error {
  readonly code = CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE

  constructor(readonly data: Readonly<{ reason: CodexLabCredentialMaterializationRefusalReason }>) {
    super(`Codex laboratory credential materialization refused: ${data.reason}`)
    this.name = 'CodexLabCredentialMaterializationRefusal'
  }
}

export type CodexAuthKeyringLocator = Readonly<{
  service: typeof CODEX_AUTH_KEYRING_SERVICE
  account: string
}>

export type CodexLabCredentialMaterializationPorts = Readonly<{
  source: Readonly<{
    readCredential(): Promise<string | null>
  }>
  targetKeyring: Readonly<{
    writeCredential(entry: CodexAuthKeyringLocator & Readonly<{ secret: string }>): Promise<void>
    readCredential(locator: CodexAuthKeyringLocator): Promise<string | null>
    deleteCredential(locator: CodexAuthKeyringLocator): Promise<void>
  }>
}>

export type CodexLabCredentialMaterializationRequest = Readonly<{
  dispatchId: string
  canonicalTargetCodexHome: string
  expectedWorkspaceId: string
  expectedPlanType: string
}>

export type CodexLabCredentialMaterializationReceipt = Readonly<{
  schemaVersion: 1
  status: 'materialized'
  store: 'keyring'
  service: typeof CODEX_AUTH_KEYRING_SERVICE
  account: string
  loginMethod: 'chatgpt'
  workspaceVerified: true
  planVerified: true
  readbackVerified: true
}>

const CHATGPT_AUTH_MODES = new Set(['chatgpt', 'chatgptAuthTokens'])
const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const NON_CHATGPT_CREDENTIAL_FIELDS = [
  'OPENAI_API_KEY',
  'agent_identity',
  'bedrock_api_key',
  'personal_access_token'
] as const

export function codexAuthKeyringAccount(canonicalTargetCodexHome: string): string {
  if (!isCanonicalTargetHome(canonicalTargetCodexHome)) {
    throw refusal('target_home_invalid')
  }
  const homeDigest = createHash('sha256').update(canonicalTargetCodexHome).digest('hex')
  return `cli|${homeDigest.slice(0, 16)}`
}

export async function materializeCodexLabChatGptCredential(
  request: CodexLabCredentialMaterializationRequest,
  ports: CodexLabCredentialMaterializationPorts
): Promise<CodexLabCredentialMaterializationReceipt> {
  assertLabTarget(request)
  const locator = Object.freeze({
    service: CODEX_AUTH_KEYRING_SERVICE,
    account: codexAuthKeyringAccount(request.canonicalTargetCodexHome)
  })

  try {
    const expectedWorkspaceId = normalizeRequiredExpectation(request.expectedWorkspaceId)
    const expectedPlanType = normalizeRequiredExpectation(request.expectedPlanType)?.toLowerCase()
    if (!expectedWorkspaceId || !expectedPlanType) {
      throw refusal('expectation_invalid')
    }

    const sourceCredential = await readSourceCredential(ports)
    assertChatGptCredential(sourceCredential, expectedWorkspaceId, expectedPlanType)
    await writeTargetCredential(ports, locator, sourceCredential)
    const readback = await readTargetCredential(ports, locator)
    if (!readback || !secretsMatch(sourceCredential, readback)) {
      throw refusal('target_readback_mismatch')
    }

    return Object.freeze({
      schemaVersion: 1,
      status: 'materialized',
      store: 'keyring',
      service: locator.service,
      account: locator.account,
      loginMethod: 'chatgpt',
      workspaceVerified: true,
      planVerified: true,
      readbackVerified: true
    })
  } catch (error) {
    try {
      await ports.targetKeyring.deleteCredential(locator)
    } catch {
      throw refusal('target_cleanup_failed')
    }
    if (error instanceof CodexLabCredentialMaterializationRefusal) {
      throw error
    }
    throw refusal('materialization_failed')
  }
}

function assertLabTarget(request: CodexLabCredentialMaterializationRequest): void {
  const expectedTarget = join(
    CODEX_LAB_RUNTIME_ROOT,
    'dispatches',
    request.dispatchId,
    'codex-home'
  )
  if (
    !DISPATCH_ID_PATTERN.test(request.dispatchId) ||
    request.dispatchId === '.' ||
    request.dispatchId === '..' ||
    request.canonicalTargetCodexHome !== expectedTarget
  ) {
    throw refusal('target_home_invalid')
  }
}

async function readSourceCredential(
  ports: CodexLabCredentialMaterializationPorts
): Promise<string> {
  let credential: string | null
  try {
    credential = await ports.source.readCredential()
  } catch {
    throw refusal('source_read_failed')
  }
  if (credential === null) {
    throw refusal('source_missing')
  }
  return credential
}

function assertChatGptCredential(
  credential: string,
  expectedWorkspaceId: string,
  expectedPlanType: string
): void {
  const auth = parseJsonRecord(credential)
  if (!auth) {
    throw refusal('source_invalid')
  }
  if (
    typeof auth.auth_mode !== 'string' ||
    !CHATGPT_AUTH_MODES.has(auth.auth_mode) ||
    NON_CHATGPT_CREDENTIAL_FIELDS.some((field) => field in auth)
  ) {
    throw refusal('auth_method_unsupported')
  }
  const tokens = isRecord(auth.tokens) ? auth.tokens : null
  if (
    !tokens ||
    !isNonEmptyString(tokens.access_token) ||
    !isNonEmptyString(tokens.id_token) ||
    !isNonEmptyString(tokens.refresh_token)
  ) {
    throw refusal('credential_incomplete')
  }

  const identity = readCodexAuthIdentity(credential)
  if (!identity || identity.workspaceAccountId !== expectedWorkspaceId) {
    throw refusal('workspace_mismatch')
  }
  if (readChatGptPlanType(tokens.id_token) !== expectedPlanType) {
    throw refusal('plan_mismatch')
  }
}

async function writeTargetCredential(
  ports: CodexLabCredentialMaterializationPorts,
  locator: CodexAuthKeyringLocator,
  credential: string
): Promise<void> {
  try {
    await ports.targetKeyring.writeCredential({ ...locator, secret: credential })
  } catch {
    throw refusal('target_write_failed')
  }
}

async function readTargetCredential(
  ports: CodexLabCredentialMaterializationPorts,
  locator: CodexAuthKeyringLocator
): Promise<string | null> {
  try {
    return await ports.targetKeyring.readCredential(locator)
  } catch {
    throw refusal('target_read_failed')
  }
}

function secretsMatch(expected: string, observed: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const observedBytes = Buffer.from(observed, 'utf8')
  return (
    expectedBytes.length === observedBytes.length && timingSafeEqual(expectedBytes, observedBytes)
  )
}

function isCanonicalTargetHome(value: string): boolean {
  return Boolean(
    value && isAbsolute(value) && normalize(value) === value && parse(value).root !== value
  )
}

function normalizeRequiredExpectation(value: string): string | null {
  const normalized = value.trim()
  return normalized && normalized === value ? normalized : null
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readChatGptPlanType(idToken: string): string | null {
  const tokenParts = idToken.split('.')
  if (tokenParts.length < 2) {
    return null
  }
  try {
    const payload = parseJsonRecord(Buffer.from(tokenParts[1], 'base64url').toString('utf8'))
    const authClaims = payload?.['https://api.openai.com/auth']
    if (!isRecord(authClaims)) {
      return null
    }
    const planType = authClaims.chatgpt_plan_type
    return isNonEmptyString(planType) ? planType.trim().toLowerCase() : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function refusal(
  reason: CodexLabCredentialMaterializationRefusalReason
): CodexLabCredentialMaterializationRefusal {
  return new CodexLabCredentialMaterializationRefusal({ reason })
}
