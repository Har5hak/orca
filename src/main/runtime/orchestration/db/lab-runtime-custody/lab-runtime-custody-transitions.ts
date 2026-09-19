import type { OrchestrationDb } from '../orchestration-db'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type {
  CodexLabRuntimeCustody,
  CodexLabRuntimeCustodyIdentity,
  CodexLabRuntimeExternalAuthEvidence,
  CodexLabRuntimeGatewayEvidence,
  CodexLabRuntimeLayoutEvidence,
  CodexLabRuntimePathIdentity,
  CodexLabRuntimeProviderCommitments,
  CodexLabRuntimeProviderEvidence,
  PlanCodexLabRuntimeCustodyInput
} from './lab-runtime-custody-contract'
import { requireCustody, requireCustodyIdentity } from './lab-runtime-custody-row'
import {
  advanceCustody,
  requireActiveAggregateCustody,
  throwStateRefusal
} from './lab-runtime-custody-state'
import { normalizeCodexLabGatewayEvidence } from './lab-runtime-custody-json-evidence'
import {
  codexLabProviderCommitments,
  normalizeCodexLabCustodyIdentity,
  normalizeCodexLabExternalAuthEvidence,
  normalizeCodexLabLayoutEvidence,
  normalizeCodexLabPlanInput,
  normalizeCodexLabProviderEvidence
} from './lab-runtime-custody-validation'

export function planCodexLabRuntimeCustody(
  this: OrchestrationDb,
  input: PlanCodexLabRuntimeCustodyInput
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabPlanInput(input)
  return runLifecycleWriteTransaction(this.db, 'plan_codex_lab_runtime_custody', () => {
    const existing = this.getCodexLabRuntimeCustody(evidence.dispatchId)
    if (existing) {
      if (
        existing.state === 'planned' &&
        existing.profileId === evidence.profileId &&
        existing.runtimeRoot === evidence.runtimeRoot
      ) {
        requireActiveAggregateCustody(this, evidence)
        return existing
      }
      throwStateRefusal(evidence.dispatchId, 'planned', existing.state)
    }
    requireActiveAggregateCustody(this, evidence)
    this.db
      .prepare(
        `INSERT INTO codex_lab_runtime_custody (
           dispatch_id, profile_id, state, runtime_root
         ) VALUES (?, ?, 'planned', ?)`
      )
      .run(evidence.dispatchId, evidence.profileId, evidence.runtimeRoot)
    return requireCustody(this, evidence.dispatchId)
  })
}

export function recordCodexLabRuntimeAuthorityAttached(
  this: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabCustodyIdentity(identity)
  return advanceCustody(this, {
    identity: evidence,
    from: 'planned',
    to: 'authority_attached'
  })
}

export function recordCodexLabRuntimeLayoutPrepared(
  this: OrchestrationDb,
  input: CodexLabRuntimeLayoutEvidence
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabLayoutEvidence(input)
  const parent = evidence.runtimeParentIdentity
  const root = evidence.runtimeRootIdentity
  const configSha256 = evidence.configSha256
  return advanceCustody(this, {
    identity: evidence,
    from: 'authority_attached',
    to: 'layout_prepared',
    assignments: `runtime_parent_device = ?, runtime_parent_inode = ?,
                  runtime_root_device = ?, runtime_root_inode = ?, config_sha256 = ?,
                  layout_cleanup_state = 'pending'`,
    values: [parent.device, parent.inode, root.device, root.inode, configSha256],
    evidenceMatches: (row) =>
      sameIdentity(row.runtimeParentIdentity, parent) &&
      sameIdentity(row.runtimeRootIdentity, root) &&
      row.configSha256 === configSha256 &&
      row.cleanup.layout.state === 'pending'
  })
}

export function recordCodexLabRuntimeProviderReserved(
  this: OrchestrationDb,
  input: CodexLabRuntimeProviderEvidence
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabProviderEvidence(input)
  const commitments = codexLabProviderCommitments(evidence)
  return runLifecycleWriteTransaction(this.db, 'reserve_codex_lab_runtime_provider', () => {
    const dispatch = this.getDispatchContextById(evidence.dispatchId)
    const worker = this.getWorkerDispatch(evidence.dispatchId)
    if (
      dispatch?.assignee_handle !== evidence.terminalHandle ||
      dispatch.assignee_pane_key !== evidence.terminalPaneKey ||
      dispatch.process_incarnation !== evidence.processIncarnation ||
      worker?.agent_terminal_handle !== evidence.terminalHandle
    ) {
      throw new Error(
        'Codex laboratory runtime provider reservation does not match attached authority.'
      )
    }
    const resource =
      this.getWorkerTerminalResourceByOwner(evidence.dispatchId) ??
      this.createWorkerTerminalResourceStatement({
        dispatchId: evidence.dispatchId,
        worktreeId: worker.worktree_id,
        terminalHandle: evidence.terminalHandle,
        paneKey: evidence.terminalPaneKey,
        processIncarnation: evidence.processIncarnation,
        endpointId: worker.runtime_epoch,
        endpointIncarnation: evidence.processIncarnation,
        hostScope: dispatch.host_scope,
        ownership: 'owned'
      })
    requireProviderResourceIdentity(resource, evidence)
    return advanceCustody(this, {
      identity: evidence,
      from: 'layout_prepared',
      to: 'provider_reserved',
      assignments: `provider_id = ?, provider_terminal_resource_id = ?,
                    provider_session_sha256 = ?, terminal_handle_sha256 = ?,
                    terminal_pane_key_sha256 = ?, process_incarnation_sha256 = ?,
                    provider_cleanup_state = 'pending'`,
      values: [
        commitments.id,
        resource.id,
        commitments.sessionSha256,
        commitments.terminalHandleSha256,
        commitments.terminalPaneKeySha256,
        commitments.processIncarnationSha256
      ],
      evidenceMatches: (row) => providerMatches(row, commitments, resource.id)
    })
  })
}

export function recordCodexLabRuntimeExternalAuthInstalled(
  this: OrchestrationDb,
  input: CodexLabRuntimeExternalAuthEvidence
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabExternalAuthEvidence(input)
  return advanceCustody(this, {
    identity: evidence,
    from: 'gateway_started',
    to: 'external_auth_installed',
    assignments: `auth_method = 'chatgptAuthTokens', auth_storage = 'ephemeral',
                  login_start_accepted = 1, auth_json_absent = 1,
                  auth_cleanup_state = 'pending'`,
    evidenceMatches: (row) =>
      row.auth?.method === 'chatgptAuthTokens' &&
      row.auth.storage === 'ephemeral' &&
      row.auth.loginStartAccepted === true &&
      row.cleanup.auth.state === 'pending'
  })
}

export function recordCodexLabRuntimeGatewayStarted(
  this: OrchestrationDb,
  input: CodexLabRuntimeGatewayEvidence
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabGatewayEvidence(input)
  const receipt = evidence.receipt
  const provider = this.getCodexLabRuntimeCustody(evidence.dispatchId)?.provider
  if (provider?.processIncarnationSha256 !== receipt.processIncarnationSha256) {
    throw new Error(
      'Codex laboratory runtime provider identity does not match the gateway receipt.'
    )
  }
  const serializedReceipt = JSON.stringify(receipt)
  return advanceCustody(this, {
    identity: evidence,
    from: 'provider_reserved',
    to: 'gateway_started',
    assignments: `gateway_public_receipt = ?, gateway_cleanup_state = 'pending'`,
    values: [serializedReceipt],
    evidenceMatches: (row) =>
      JSON.stringify(row.gatewayReceipt) === serializedReceipt &&
      row.cleanup.gateway.state === 'pending'
  })
}

export function recordCodexLabRuntimeProviderAttached(
  this: OrchestrationDb,
  input: CodexLabRuntimeProviderEvidence
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabProviderEvidence(input)
  const commitments = codexLabProviderCommitments(evidence)
  const current = this.getCodexLabRuntimeCustody(evidence.dispatchId)
  const resource = current?.provider
    ? this.getWorkerTerminalResource(current.provider.terminalResourceId)
    : undefined
  if (
    !resource ||
    current?.gatewayReceipt?.processIncarnationSha256 !== commitments.processIncarnationSha256 ||
    !providerMatches(current, commitments, current?.provider?.terminalResourceId)
  ) {
    throw new Error(
      'Codex laboratory runtime provider identity does not match the gateway receipt.'
    )
  }
  requireProviderResourceIdentity(resource, evidence)
  return advanceCustody(this, {
    identity: evidence,
    from: 'external_auth_installed',
    to: 'provider_attached',
    evidenceMatches: (row) =>
      providerMatches(row, commitments, current?.provider?.terminalResourceId)
  })
}

export function recordCodexLabRuntimeReady(
  this: OrchestrationDb,
  identity: CodexLabRuntimeCustodyIdentity
): CodexLabRuntimeCustody {
  const evidence = normalizeCodexLabCustodyIdentity(identity)
  if (!requireCustodyIdentity(this, evidence).launchReceipt) {
    throw new Error('Codex laboratory runtime cannot become ready without its launch receipt.')
  }
  return advanceCustody(this, { identity: evidence, from: 'provider_attached', to: 'ready' })
}

function providerMatches(
  row: CodexLabRuntimeCustody | undefined,
  commitments: CodexLabRuntimeProviderCommitments,
  terminalResourceId: string | undefined
): boolean {
  return (
    row?.provider?.id === commitments.id &&
    row.provider.terminalResourceId === terminalResourceId &&
    row.provider.sessionSha256 === commitments.sessionSha256 &&
    row.provider.terminalHandleSha256 === commitments.terminalHandleSha256 &&
    row.provider.terminalPaneKeySha256 === commitments.terminalPaneKeySha256 &&
    row.provider.processIncarnationSha256 === commitments.processIncarnationSha256 &&
    row.cleanup.provider.state === 'pending'
  )
}

function requireProviderResourceIdentity(
  resource: Readonly<{
    owner_dispatch_id: string
    terminal_handle: string
    pane_key: string | null
    process_incarnation: string | null
    ownership_state: string
    release_state: string
  }>,
  evidence: CodexLabRuntimeProviderEvidence
): void {
  if (
    resource.owner_dispatch_id !== evidence.dispatchId ||
    resource.terminal_handle !== evidence.terminalHandle ||
    resource.pane_key !== evidence.terminalPaneKey ||
    resource.process_incarnation !== evidence.processIncarnation ||
    resource.ownership_state !== 'owned' ||
    resource.release_state === 'released'
  ) {
    throw new Error(
      'Codex laboratory runtime provider reservation does not match terminal custody.'
    )
  }
}

function sameIdentity(
  left: CodexLabRuntimePathIdentity | null,
  right: CodexLabRuntimePathIdentity
): boolean {
  return left?.device === right.device && left.inode === right.inode
}
