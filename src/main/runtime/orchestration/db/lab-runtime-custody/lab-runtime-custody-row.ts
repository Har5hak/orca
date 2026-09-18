import {
  CODEX_WORKSPACE_CHATGPT_ADAPTER_ID,
  LAB_READONLY_SUPERVISED_PROFILE_ID
} from '../../lab-profile/codex-lab-launch-contract'
import type { OrchestrationDb } from '../orchestration-db'
import { isGeneratedId } from '../generated-id'
import {
  CODEX_LAB_RUNTIME_CLEANUP_REASON_CODES,
  CODEX_LAB_RUNTIME_CUSTODY_STATES,
  type CodexLabGatewayPublicReceipt,
  type CodexLabRuntimeCleanupReasonCode,
  type CodexLabRuntimeCleanupState,
  type CodexLabRuntimeCustody,
  type CodexLabRuntimeCustodyIdentity,
  type CodexLabRuntimeCustodyState,
  type CodexLabRuntimePathIdentity
} from './lab-runtime-custody-contract'
import { requireCodexLabRuntimeCustodyInvariants } from './lab-runtime-custody-invariants'
import { normalizeCodexLabGatewayPublicReceipt } from './lab-runtime-custody-json-evidence'
import {
  normalizeCodexLabPathIdentity,
  requireCodexLabCustodyIdentityParts,
  requireCodexLabRuntimeRoot,
  requireSha256
} from './lab-runtime-custody-validation'

type CustodySqlRow = {
  dispatch_id: string
  profile_id: string
  state: string
  runtime_root: string
  runtime_parent_device: string | null
  runtime_parent_inode: string | null
  runtime_root_device: string | null
  runtime_root_inode: string | null
  config_sha256: string | null
  auth_method: string | null
  auth_storage: string | null
  login_start_accepted: number | null
  auth_json_absent: number | null
  gateway_public_receipt: string | null
  provider_id: string | null
  provider_terminal_resource_id: string | null
  provider_session_sha256: string | null
  terminal_handle_sha256: string | null
  terminal_pane_key_sha256: string | null
  process_incarnation_sha256: string | null
  layout_cleanup_state: string
  layout_cleanup_reason_code: string | null
  layout_cleanup_detail_sha256: string | null
  auth_cleanup_state: string
  auth_cleanup_reason_code: string | null
  auth_cleanup_detail_sha256: string | null
  gateway_cleanup_state: string
  gateway_cleanup_reason_code: string | null
  gateway_cleanup_detail_sha256: string | null
  provider_cleanup_state: string
  provider_cleanup_reason_code: string | null
  provider_cleanup_detail_sha256: string | null
  revision: number
  created_at: string
  updated_at: string
}

const CUSTODY_COLUMNS = `
  dispatch_id, profile_id, state, runtime_root,
  runtime_parent_device, runtime_parent_inode, runtime_root_device, runtime_root_inode,
  config_sha256, auth_method, auth_storage, login_start_accepted,
  auth_json_absent, gateway_public_receipt, provider_id, provider_terminal_resource_id,
  provider_session_sha256,
  terminal_handle_sha256, terminal_pane_key_sha256, process_incarnation_sha256,
  layout_cleanup_state, layout_cleanup_reason_code, layout_cleanup_detail_sha256,
  auth_cleanup_state, auth_cleanup_reason_code, auth_cleanup_detail_sha256,
  gateway_cleanup_state, gateway_cleanup_reason_code, gateway_cleanup_detail_sha256,
  provider_cleanup_state, provider_cleanup_reason_code, provider_cleanup_detail_sha256,
  revision, created_at, updated_at
`

export function getCodexLabRuntimeCustody(
  this: OrchestrationDb,
  dispatchId: string
): CodexLabRuntimeCustody | undefined {
  const raw = this.db
    .prepare(`SELECT ${CUSTODY_COLUMNS} FROM codex_lab_runtime_custody WHERE dispatch_id = ?`)
    .get(dispatchId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixed SELECT list names every field; custodyFromSql validates every persisted value.
  const row = raw as CustodySqlRow | undefined
  return row ? custodyFromSql(row) : undefined
}

export function requireCustody(db: OrchestrationDb, dispatchId: string): CodexLabRuntimeCustody {
  const row = getCodexLabRuntimeCustody.call(db, dispatchId)
  if (!row) {
    throw new Error(`Codex laboratory runtime custody for Dispatch ${dispatchId} was not found.`)
  }
  return row
}

export function requireCustodyIdentity(
  db: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): CodexLabRuntimeCustody {
  const row = requireCustody(db, identity.dispatchId)
  if (row.profileId !== identity.profileId) {
    throw new Error('Codex laboratory runtime custody profile does not match its Dispatch.')
  }
  return row
}

function custodyFromSql(row: CustodySqlRow): CodexLabRuntimeCustody {
  requireCodexLabCustodyIdentityParts(row.dispatch_id, row.profile_id)
  requireCodexLabRuntimeRoot(row.dispatch_id, row.runtime_root)
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error('Codex laboratory runtime custody revision is invalid.')
  }
  const custody: CodexLabRuntimeCustody = Object.freeze({
    dispatchId: row.dispatch_id,
    profileId: LAB_READONLY_SUPERVISED_PROFILE_ID,
    state: requireCustodyState(row.state),
    runtimeRoot: row.runtime_root,
    runtimeParentIdentity: optionalIdentity(
      row.runtime_parent_device,
      row.runtime_parent_inode,
      'runtime parent identity'
    ),
    runtimeRootIdentity: optionalIdentity(
      row.runtime_root_device,
      row.runtime_root_inode,
      'runtime root identity'
    ),
    configSha256: row.config_sha256 ? requireSha256(row.config_sha256, 'config digest') : null,
    auth: parseAuth(row),
    gatewayReceipt: parseGatewayReceipt(row.gateway_public_receipt, row.dispatch_id),
    provider: parseProvider(row),
    cleanup: Object.freeze({
      layout: cleanupEntry(
        row.layout_cleanup_state,
        row.layout_cleanup_reason_code,
        row.layout_cleanup_detail_sha256
      ),
      auth: cleanupEntry(
        row.auth_cleanup_state,
        row.auth_cleanup_reason_code,
        row.auth_cleanup_detail_sha256
      ),
      gateway: cleanupEntry(
        row.gateway_cleanup_state,
        row.gateway_cleanup_reason_code,
        row.gateway_cleanup_detail_sha256
      ),
      provider: cleanupEntry(
        row.provider_cleanup_state,
        row.provider_cleanup_reason_code,
        row.provider_cleanup_detail_sha256
      )
    }),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
  requireCodexLabRuntimeCustodyInvariants(custody)
  return custody
}

function parseAuth(row: CustodySqlRow): CodexLabRuntimeCustody['auth'] {
  const values = [row.auth_method, row.auth_storage, row.login_start_accepted, row.auth_json_absent]
  if (values.every((value) => value === null)) {
    return null
  }
  if (
    row.auth_method !== 'chatgptAuthTokens' ||
    row.auth_storage !== 'ephemeral' ||
    row.login_start_accepted !== 1 ||
    row.auth_json_absent !== 1
  ) {
    throw new Error('Codex laboratory runtime external auth custody is malformed.')
  }
  return Object.freeze({
    method: 'chatgptAuthTokens' as const,
    storage: 'ephemeral' as const,
    loginStartAccepted: true as const,
    authJsonAbsent: true as const
  })
}

function parseProvider(row: CustodySqlRow): CodexLabRuntimeCustody['provider'] {
  const values = [
    row.provider_id,
    row.provider_terminal_resource_id,
    row.provider_session_sha256,
    row.terminal_handle_sha256,
    row.terminal_pane_key_sha256,
    row.process_incarnation_sha256
  ]
  if (values.every((value) => value === null)) {
    return null
  }
  if (values.some((value) => value === null)) {
    throw new Error('Codex laboratory runtime provider custody is malformed.')
  }
  return Object.freeze({
    id: requireProviderId(row.provider_id),
    terminalResourceId: requireTerminalResourceId(row.provider_terminal_resource_id),
    sessionSha256: requireSha256Value(row.provider_session_sha256, 'provider session digest'),
    terminalHandleSha256: requireSha256Value(row.terminal_handle_sha256, 'terminal handle digest'),
    terminalPaneKeySha256: requireSha256Value(
      row.terminal_pane_key_sha256,
      'terminal pane key digest'
    ),
    processIncarnationSha256: requireSha256Value(
      row.process_incarnation_sha256,
      'process incarnation digest'
    )
  })
}

function parseGatewayReceipt(
  serialized: string | null,
  dispatchId: string
): CodexLabGatewayPublicReceipt | null {
  if (serialized === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new Error('Codex laboratory runtime gateway receipt is malformed.')
  }
  return normalizeCodexLabGatewayPublicReceipt(parsed, dispatchId)
}

function optionalIdentity(
  device: string | null,
  inode: string | null,
  field: string
): CodexLabRuntimePathIdentity | null {
  if (device === null && inode === null) {
    return null
  }
  if (device === null || inode === null) {
    throw new Error(`Codex laboratory runtime custody ${field} is incomplete.`)
  }
  return normalizeCodexLabPathIdentity({ device, inode }, field)
}

function cleanupEntry(state: string, reasonCode: string | null, detailSha256: string | null) {
  const normalizedState = requireCleanupState(state)
  const normalizedReasonCode = reasonCode === null ? null : requireCleanupReasonCode(reasonCode)
  const normalizedDetailSha256 =
    detailSha256 === null ? null : requireSha256(detailSha256, 'cleanup detail digest')
  if (
    (normalizedState === 'failed' || normalizedState === 'unproven') !==
      (normalizedReasonCode !== null) ||
    (normalizedDetailSha256 !== null && normalizedReasonCode === null)
  ) {
    throw new Error('Codex laboratory runtime cleanup evidence is malformed.')
  }
  return Object.freeze({
    state: normalizedState,
    reasonCode: normalizedReasonCode,
    detailSha256: normalizedDetailSha256
  })
}

function requireCustodyState(value: string): CodexLabRuntimeCustodyState {
  const state = CODEX_LAB_RUNTIME_CUSTODY_STATES.find((candidate) => candidate === value)
  if (!state) {
    throw new Error('Codex laboratory runtime custody state is invalid.')
  }
  return state
}

function requireCleanupState(value: string): CodexLabRuntimeCleanupState {
  if (
    value !== 'not_created' &&
    value !== 'pending' &&
    value !== 'failed' &&
    value !== 'unproven' &&
    value !== 'released'
  ) {
    throw new Error('Codex laboratory runtime cleanup state is invalid.')
  }
  return value
}

function requireProviderId(value: string | null): typeof CODEX_WORKSPACE_CHATGPT_ADAPTER_ID {
  if (value !== CODEX_WORKSPACE_CHATGPT_ADAPTER_ID) {
    throw new Error('Codex laboratory runtime provider id is invalid.')
  }
  return value
}

function requireTerminalResourceId(value: string | null): string {
  if (!value || !isGeneratedId(value, 'wtr')) {
    throw new Error('Codex laboratory runtime provider resource reference is invalid.')
  }
  return value
}

function requireSha256Value(value: string | null, field: string): string {
  if (value === null) {
    throw new Error(`Codex laboratory runtime ${field} is missing.`)
  }
  return requireSha256(value, field)
}

function requireCleanupReasonCode(value: string): CodexLabRuntimeCleanupReasonCode {
  const reason = CODEX_LAB_RUNTIME_CLEANUP_REASON_CODES.find((candidate) => candidate === value)
  if (!reason) {
    throw new Error('Codex laboratory runtime cleanup reason code is invalid.')
  }
  return reason
}
