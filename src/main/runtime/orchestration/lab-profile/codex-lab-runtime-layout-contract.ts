export const CODEX_LAB_LAYOUT_DIRECTORY_MODE = 0o700
export const CODEX_LAB_LAYOUT_CONFIG_MODE = 0o600
export const CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE_CODE =
  'ORCA_CODEX_LAB_RUNTIME_CLEANUP_INCOMPLETE' as const

export type CodexLabPathIdentity = Readonly<{
  device: string
  inode: string
}>

export type CodexLabRuntimeLayoutRemovalEvidence = Readonly<{
  evidence: string
  /** Present when removal revoked a captured active layout into a retained quarantine. */
  quarantinePath?: string
  /** Captured identity retained at `quarantinePath`. */
  rootIdentity?: CodexLabPathIdentity
}>

export type CodexLabPathObservation =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'directory' | 'file' | 'other'
      mode: number
      ownedByCurrentUser: boolean
      identity: CodexLabPathIdentity
    }>

export type CodexLabExistingPathObservation = Exclude<
  CodexLabPathObservation,
  Readonly<{ kind: 'absent' }>
>

/**
 * The layout host owns filesystem mechanics only. It cannot probe policy or spawn a provider.
 * Every mutating operation is parent-identity fenced; removal additionally requires the exact
 * dev/inode pair captured when this Dispatch root was created.
 */
export type CodexLabRuntimeLayoutHost = Readonly<{
  observePath(path: string): Promise<CodexLabPathObservation>
  makeDirectoryExclusive(
    path: string,
    mode: number,
    expectedParent: CodexLabPathIdentity
  ): Promise<CodexLabExistingPathObservation>
  writeFileExclusive(
    path: string,
    contents: string,
    mode: number,
    expectedParent: CodexLabPathIdentity
  ): Promise<CodexLabExistingPathObservation>
  sha256File(path: string, expectedFile: CodexLabPathIdentity): Promise<string>
  removeTree(
    path: string,
    expectedRoot: CodexLabPathIdentity,
    expectedParent: CodexLabPathIdentity
  ): Promise<CodexLabRuntimeLayoutRemovalEvidence>
}>

export type PreparedCodexLabRuntimeLayout = Readonly<{
  schemaVersion: 1
  dispatchId: string
  dispatchesRootIdentity: CodexLabPathIdentity
  dispatchRoot: string
  dispatchRootIdentity: CodexLabPathIdentity
  codexHome: string
  codexHomeIdentity: CodexLabPathIdentity
  fakeHome: string
  fakeHomeIdentity: CodexLabPathIdentity
  configPath: string
  configIdentity: CodexLabPathIdentity
  configSha256: string
}>

export type CodexLabRuntimeLayoutStage =
  | 'validate_plan'
  | 'prepare_parents'
  | 'freshness'
  | 'create_layout'
  | 'write_config'
  | 'verify_layout'
  | 'verify_config_digest'

export type CodexLabRuntimeLayoutReason =
  | 'plan_invalid'
  | 'layout_path_invalid'
  | 'parent_layout_invalid'
  | 'dispatch_root_not_fresh'
  | 'layout_verification_failed'
  | 'config_digest_mismatch'
  | 'host_operation_failed'

export type CodexLabRuntimeLayoutRollback =
  | Readonly<{
      action: 'remove_dispatch_root'
      status: 'succeeded'
      evidence: string
      quarantinePath?: string
      rootIdentity?: CodexLabPathIdentity
    }>
  | Readonly<{
      action: 'remove_dispatch_root'
      status: 'failed'
      reason: 'cleanup_incomplete' | 'cleanup_failed'
      evidence: string
    }>

export type CodexLabRuntimeLayoutResult =
  | Readonly<{
      ok: true
      prepared: PreparedCodexLabRuntimeLayout
      rollback: readonly CodexLabRuntimeLayoutRollback[]
    }>
  | Readonly<{
      ok: false
      stage: CodexLabRuntimeLayoutStage
      reason: CodexLabRuntimeLayoutReason
      message: string
      rollback: readonly CodexLabRuntimeLayoutRollback[]
    }>

export type ExpectedCodexLabLayoutPaths = Readonly<{
  dispatchRoot: string
  codexHome: string
  fakeHome: string
  configPath: string
}>
