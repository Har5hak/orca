export const LAB_READONLY_SUPERVISED_PROFILE_ID = 'lab-readonly-supervised-v1'
export const CODEX_WORKSPACE_CHATGPT_ADAPTER_ID = 'codex-workspace-chatgpt-v1'
export const CODEX_LAB_RUNTIME_ROOT = '/private/tmp/orca-lab/runtime'
export const CODEX_LAB_LAUNCH_REFUSAL_CODE = 'ORCA_CODEX_LAB_LAUNCH_REFUSED'

export type CodexLabLaunchRefusalReason =
  | 'adapter_unsupported'
  | 'ambient_env_not_allowlisted'
  | 'auth_json_forbidden'
  | 'binary_not_pinned'
  | 'binary_path_invalid'
  | 'dispatch_home_not_fresh'
  | 'dispatch_invalid'
  | 'forbidden_ambient_env'
  | 'gateway_invalid'
  | 'keyring_unavailable'
  | 'launch_plan_policy_broadened'
  | 'login_method_unsupported'
  | 'platform_unsupported'
  | 'profile_unsupported'
  | 'subscription_status_ambiguous'
  | 'workspace_identity_invalid'
  | 'worktree_invalid'

export class CodexLabLaunchRefusal extends Error {
  readonly code = CODEX_LAB_LAUNCH_REFUSAL_CODE

  constructor(
    readonly data: Readonly<{
      reason: CodexLabLaunchRefusalReason
      field?: string
    }>
  ) {
    super(`Codex laboratory launch refused: ${data.reason}`)
    this.name = 'CodexLabLaunchRefusal'
  }
}

export type CodexLabLaunchFacts = Readonly<{
  platform: string
  profile: string
  adapter: string
  dispatch: Readonly<{
    id: string
    runtimeRoot: string
    codexHomeState: 'absent' | 'present'
    fakeHomeState: 'absent' | 'present'
  }>
  worktree: Readonly<{
    identity: string
    expectedPath: string
    observedPath: string
    observedRealPath: string
    kind: 'directory' | 'missing' | 'other'
    disposable: boolean
  }>
  gateway: Readonly<{
    socketPath: string
    credential: string
  }>
  binary: Readonly<{
    path: string
    observedRealPath: string
    kind: 'regular-file' | 'symlink' | 'missing' | 'other'
    executable: boolean
    pinnedSha256: string
    observedSha256: string
  }>
  authentication: Readonly<{
    keyringAvailable: boolean
    keyringBackend: string
    loginMethod: string
    expectedWorkspaceId: string
    observedWorkspaceId: string
    subscription: Readonly<{
      status: string
      scope: string
      unambiguous: boolean
    }>
    authJson:
      | Readonly<{ state: 'absent' }>
      | Readonly<{ state: 'copied'; sourcePath: string }>
      | Readonly<{ state: 'symlink'; targetPath: string }>
      | Readonly<{ state: 'regular-file' }>
  }>
  ambientEnv: Readonly<Record<string, string>>
}>

export type CodexLabReceiptInputs = Readonly<{
  schemaVersion: 1
  dispatchId: string
  profile: typeof LAB_READONLY_SUPERVISED_PROFILE_ID
  adapter: typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
  platform: 'darwin'
  worktreeIdentity: string
  worktreePath: string
  codexExecutablePath: string
  codexExecutableSha256: string
  keyringBackend: 'macos-keychain'
  loginMethod: 'chatgpt'
  subscriptionStatus: 'active-workspace'
  gatewaySocketPathSha256: string
  gatewayAccessSha256: string
  configSha256: string
  argvSha256: string
}>

export type SealedCodexLabLaunchPlan = Readonly<{
  dispatchId: string
  profile: typeof LAB_READONLY_SUPERVISED_PROFILE_ID
  adapter: typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID
  worktreeIdentity: string
  executable: string
  codexExecutableSha256: string
  argv: readonly string[]
  cwd: string
  environment: Readonly<{
    ambientAllowlist: readonly string[]
    inherited: Readonly<Record<string, string>>
    injected: Readonly<Record<string, string>>
  }>
  runtimePaths: Readonly<{
    codexHome: string
    fakeHome: string
  }>
  gatewaySocketPath: string
  gatewayAccessSha256: string
  enforcedWorkspaceId: string
  configToml: string
  receiptInputs: CodexLabReceiptInputs
  unverifiedBoundaries: readonly [
    'effective-config-enforcement',
    'filesystem-confinement',
    'network-confinement',
    'process-spawn',
    'provider-session'
  ]
}>

export function refuse(reason: CodexLabLaunchRefusalReason, field?: string): never {
  throw new CodexLabLaunchRefusal(field ? { reason, field } : { reason })
}
