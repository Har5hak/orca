import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import {
  CODEX_LAB_RUNTIME_ROOT,
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID,
  refuse,
  type CodexLabLaunchFacts,
  type CodexLabReceiptInputs,
  type SealedCodexLabLaunchPlan
} from './codex-lab-launch-contract'
import {
  UNVERIFIED_CODEX_LAB_BOUNDARIES,
  buildCodexLabArgv,
  renderCodexLabConfig
} from './codex-lab-launch-policy'

export {
  CODEX_LAB_LAUNCH_REFUSAL_CODE,
  type CodexLabLaunchFacts,
  type SealedCodexLabLaunchPlan
} from './codex-lab-launch-contract'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const DISPATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const LOCAL_WORKTREE_IDENTITY_PATTERN = /^wt2:local:[A-Za-z0-9][A-Za-z0-9._-]*$/
const LAB_GATEWAY_CREDENTIAL_PATTERN = /^lgw1_[A-Za-z0-9_-]{43}$/
const FORBIDDEN_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'AZURE_',
  'BEDROCK_',
  'CLAUDE_',
  'COHERE_',
  'GEMINI_',
  'GOOGLE_',
  'LMSTUDIO_',
  'MISTRAL_',
  'OLLAMA_',
  'OPENAI_',
  'OPENROUTER_'
]
const FORBIDDEN_ENV_FRAGMENTS = [
  'ACCESS_TOKEN',
  'API_KEY',
  'AUTH_TOKEN',
  'BEARER_TOKEN',
  'CREDENTIAL',
  'SECRET'
]

export function buildSealedCodexLabLaunchPlan(
  facts: CodexLabLaunchFacts
): SealedCodexLabLaunchPlan {
  validateFacts(facts)
  const runtimePaths = Object.freeze({
    codexHome: join(facts.dispatch.runtimeRoot, 'dispatches', facts.dispatch.id, 'codex-home'),
    fakeHome: join(facts.dispatch.runtimeRoot, 'dispatches', facts.dispatch.id, 'fake-home')
  })
  const argv = Object.freeze(buildCodexLabArgv())
  const configToml = renderCodexLabConfig({
    workspaceId: facts.authentication.expectedWorkspaceId,
    worktreePath: facts.worktree.expectedPath,
    ...runtimePaths
  })
  const receiptInputs = buildReceiptInputs(facts, argv, configToml)
  const plan: SealedCodexLabLaunchPlan = Object.freeze({
    dispatchId: facts.dispatch.id,
    profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
    adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    worktreeIdentity: facts.worktree.identity,
    executable: facts.binary.path,
    codexExecutableSha256: facts.binary.observedSha256,
    argv,
    cwd: facts.worktree.expectedPath,
    environment: Object.freeze({
      ambientAllowlist: Object.freeze([]),
      inherited: Object.freeze({}),
      injected: Object.freeze({
        CODEX_HOME: runtimePaths.codexHome,
        HOME: runtimePaths.fakeHome
      })
    }),
    runtimePaths,
    gatewaySocketPath: facts.gateway.socketPath,
    gatewayAccessSha256: sha256(facts.gateway.credential),
    enforcedWorkspaceId: facts.authentication.expectedWorkspaceId,
    configToml,
    receiptInputs,
    unverifiedBoundaries: UNVERIFIED_CODEX_LAB_BOUNDARIES
  })
  assertSealedCodexLabLaunchPlan(plan)
  return plan
}

export function assertSealedCodexLabLaunchPlan(plan: SealedCodexLabLaunchPlan): void {
  if (
    plan.profile !== LAB_READONLY_SUPERVISED_PROFILE_ID ||
    plan.adapter !== CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
  ) {
    refuse('launch_plan_policy_broadened', 'admission')
  }
  const expectedArgv = buildCodexLabArgv()
  if (!sameStrings(plan.argv, expectedArgv)) {
    refuse('launch_plan_policy_broadened', 'argv')
  }
  if (
    plan.environment.ambientAllowlist.length !== 0 ||
    Object.keys(plan.environment.inherited).length !== 0 ||
    !sameStringRecord(plan.environment.injected, {
      CODEX_HOME: plan.runtimePaths.codexHome,
      HOME: plan.runtimePaths.fakeHome
    }) ||
    !SHA256_PATTERN.test(plan.gatewayAccessSha256)
  ) {
    refuse('launch_plan_policy_broadened', 'environment')
  }
  const expectedConfig = renderCodexLabConfig({
    workspaceId: plan.enforcedWorkspaceId,
    worktreePath: plan.cwd,
    ...plan.runtimePaths
  })
  if (plan.configToml !== expectedConfig) {
    refuse('launch_plan_policy_broadened', 'configToml')
  }
  if (!sameStrings(plan.unverifiedBoundaries, UNVERIFIED_CODEX_LAB_BOUNDARIES)) {
    refuse('launch_plan_policy_broadened', 'unverifiedBoundaries')
  }
  const expectedReceipt: CodexLabReceiptInputs = {
    schemaVersion: 1,
    dispatchId: plan.dispatchId,
    profile: plan.profile,
    adapter: plan.adapter,
    platform: 'darwin',
    worktreeIdentity: plan.worktreeIdentity,
    worktreePath: plan.cwd,
    codexExecutablePath: plan.executable,
    codexExecutableSha256: plan.codexExecutableSha256,
    loginMethod: 'chatgpt',
    subscriptionStatus: 'active-workspace',
    gatewaySocketPathSha256: sha256(plan.gatewaySocketPath),
    gatewayAccessSha256: plan.gatewayAccessSha256,
    configSha256: sha256(plan.configToml),
    argvSha256: sha256(plan.argv.join('\0'))
  }
  if (JSON.stringify(plan.receiptInputs) !== JSON.stringify(expectedReceipt)) {
    refuse('launch_plan_policy_broadened', 'receiptInputs')
  }
}

function validateFacts(facts: CodexLabLaunchFacts): void {
  if (facts.platform !== 'darwin') {
    refuse('platform_unsupported', 'platform')
  }
  if (facts.profile !== LAB_READONLY_SUPERVISED_PROFILE_ID) {
    refuse('profile_unsupported', 'profile')
  }
  if (facts.adapter !== CODEX_WORKSPACE_CHATGPT_ADAPTER_ID) {
    refuse('adapter_unsupported', 'adapter')
  }
  validateDispatch(facts)
  validateWorktree(facts)
  validateGateway(facts)
  validateBinary(facts)
  validateAuthentication(facts)
  validateAmbientEnvironment(facts.ambientEnv)
}

function validateGateway(facts: CodexLabLaunchFacts): void {
  const expectedDispatchRoot = join(facts.dispatch.runtimeRoot, 'dispatches', facts.dispatch.id)
  if (
    !isCanonicalAbsolutePath(facts.gateway.socketPath) ||
    dirname(facts.gateway.socketPath) !== expectedDispatchRoot ||
    !LAB_GATEWAY_CREDENTIAL_PATTERN.test(facts.gateway.credential)
  ) {
    refuse('gateway_invalid', 'gateway.socketPath')
  }
}

function validateDispatch(facts: CodexLabLaunchFacts): void {
  if (
    !DISPATCH_ID_PATTERN.test(facts.dispatch.id) ||
    facts.dispatch.id === '.' ||
    facts.dispatch.id === '..' ||
    facts.dispatch.runtimeRoot !== CODEX_LAB_RUNTIME_ROOT ||
    !isCanonicalAbsolutePath(facts.dispatch.runtimeRoot)
  ) {
    refuse('dispatch_invalid', 'dispatch')
  }
  if (facts.dispatch.codexHomeState !== 'absent') {
    refuse('dispatch_home_not_fresh', 'dispatch.codexHomeState')
  }
  if (facts.dispatch.fakeHomeState !== 'absent') {
    refuse('dispatch_home_not_fresh', 'dispatch.fakeHomeState')
  }
}

function validateWorktree(facts: CodexLabLaunchFacts): void {
  const worktree = facts.worktree
  if (
    !LOCAL_WORKTREE_IDENTITY_PATTERN.test(worktree.identity) ||
    !isCanonicalAbsolutePath(worktree.expectedPath) ||
    worktree.observedPath !== worktree.expectedPath ||
    worktree.observedRealPath !== worktree.expectedPath ||
    worktree.kind !== 'directory' ||
    !worktree.disposable
  ) {
    refuse('worktree_invalid', 'worktree')
  }
}

function validateBinary(facts: CodexLabLaunchFacts): void {
  const binary = facts.binary
  if (!isCanonicalAbsolutePath(binary.path)) {
    refuse('binary_path_invalid', 'binary.path')
  }
  if (
    binary.observedRealPath !== binary.path ||
    binary.kind !== 'regular-file' ||
    !binary.executable ||
    !SHA256_PATTERN.test(binary.pinnedSha256) ||
    binary.observedSha256 !== binary.pinnedSha256
  ) {
    refuse('binary_not_pinned', 'binary')
  }
}

function validateAuthentication(facts: CodexLabLaunchFacts): void {
  const authentication = facts.authentication
  if (authentication.loginMethod !== 'chatgpt') {
    refuse('login_method_unsupported', 'authentication.loginMethod')
  }
  if (
    !UUID_PATTERN.test(authentication.expectedWorkspaceId) ||
    authentication.observedWorkspaceId !== authentication.expectedWorkspaceId
  ) {
    refuse('workspace_identity_invalid', 'authentication.observedWorkspaceId')
  }
  const subscription = authentication.subscription
  if (
    subscription.status !== 'active' ||
    subscription.scope !== 'workspace' ||
    !subscription.unambiguous
  ) {
    refuse('subscription_status_ambiguous', 'authentication.subscription')
  }
  if (authentication.authJson.state !== 'absent') {
    refuse('auth_json_forbidden', 'authentication.authJson')
  }
}

function validateAmbientEnvironment(env: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(env).sort()) {
    const upperName = name.toUpperCase()
    const proxyName = upperName === 'NO_PROXY' || upperName.endsWith('_PROXY')
    if (
      proxyName ||
      FORBIDDEN_ENV_PREFIXES.some((prefix) => upperName.startsWith(prefix)) ||
      FORBIDDEN_ENV_FRAGMENTS.some((fragment) => upperName.includes(fragment))
    ) {
      refuse('forbidden_ambient_env', name)
    }
    refuse('ambient_env_not_allowlisted', name)
  }
}

function buildReceiptInputs(
  facts: CodexLabLaunchFacts,
  argv: readonly string[],
  configToml: string
): CodexLabReceiptInputs {
  return Object.freeze({
    schemaVersion: 1,
    dispatchId: facts.dispatch.id,
    profile: LAB_READONLY_SUPERVISED_PROFILE_ID,
    adapter: CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
    platform: 'darwin',
    worktreeIdentity: facts.worktree.identity,
    worktreePath: facts.worktree.expectedPath,
    codexExecutablePath: facts.binary.path,
    codexExecutableSha256: facts.binary.observedSha256,
    loginMethod: 'chatgpt',
    subscriptionStatus: 'active-workspace',
    gatewaySocketPathSha256: sha256(facts.gateway.socketPath),
    gatewayAccessSha256: sha256(facts.gateway.credential),
    configSha256: sha256(configToml),
    argvSha256: sha256(argv.join('\0'))
  })
}

function isCanonicalAbsolutePath(value: string): boolean {
  return value !== '/' && isAbsolute(value) && normalize(value) === value
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return sameStrings(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key])
}
