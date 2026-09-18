import { createHash } from 'node:crypto'
import type { OrchestrationDb } from '../db'
import type { CodexLabRuntimeCustody } from '../db/lab-runtime-custody/lab-runtime-custody-contract'
import type { WorkerTerminalResourceRow } from '../worker-terminal-ownership'
import {
  isStructuredWorkerHandle,
  sessionIdFromStructuredWorkerIncarnation
} from '../../structured-worker-identity'
import { LAB_READONLY_SUPERVISED_PROFILE_ID } from './codex-lab-launch-contract'
import { getCodexLabExternalChatGptAuthMetadata } from './codex-lab-external-chatgpt-auth-registry'
import {
  requireCodexLabRuntimeLayoutRemovalEvidence,
  type CodexLabRuntimeLayoutRemovalEvidence
} from './codex-lab-runtime-layout'

type CleanupAuthority = Readonly<{
  dispatchId: string
  sessionId: string
  terminalHandle: string
  terminalPaneKey: string
  processIncarnation: string
  stopGateway(): Promise<void>
  removeLayout(): Promise<CodexLabRuntimeLayoutRemovalEvidence>
}>

const authorities = new Map<string, CleanupAuthority>()

export function registerCodexLabRuntimeCleanupAuthority(
  authority: CleanupAuthority
): () => boolean {
  if (
    authorities.has(authority.dispatchId) ||
    !isStructuredWorkerHandle(authority.terminalHandle) ||
    sessionIdFromStructuredWorkerIncarnation(authority.processIncarnation) !== authority.sessionId
  ) {
    throw new Error('Codex laboratory runtime cleanup authority conflicts or is invalid.')
  }
  const registered = Object.freeze({ ...authority })
  authorities.set(authority.dispatchId, registered)
  return () => deleteAuthority(authority.dispatchId, registered)
}

export async function cleanupReleasedCodexLabRuntime(input: {
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
}): Promise<'not_registered' | 'released' | 'cleanup_pending'> {
  const durableCustody = input.db.getCodexLabRuntimeCustody(input.dispatchId)
  const sessionId = sessionIdFromStructuredWorkerIncarnation(input.resource.process_incarnation)
  if (!sessionId) {
    return durableCustody && durableCustody.state !== 'released'
      ? 'cleanup_pending'
      : 'not_registered'
  }
  const authority = authorities.get(input.dispatchId)
  if (!authority) {
    return durableCustody && durableCustody.state !== 'released'
      ? 'cleanup_pending'
      : 'not_registered'
  }
  if (!matchesReleasedResource(authority, input.resource)) {
    throw new Error('Released worker does not match Codex laboratory cleanup authority.')
  }
  const identity = {
    dispatchId: input.dispatchId,
    profileId: LAB_READONLY_SUPERVISED_PROFILE_ID
  } as const
  let custody = input.db.beginCodexLabRuntimeCleanup(identity)
  if (custody.cleanup.provider.state !== 'not_created') {
    custody = input.db.recordCodexLabRuntimeCleanupResult({
      ...identity,
      resource: 'provider',
      outcome: 'released'
    })
  }
  if (getCodexLabExternalChatGptAuthMetadata(sessionId) !== undefined) {
    if (custody.cleanup.auth.state !== 'not_created') {
      input.db.recordCodexLabRuntimeCleanupResult({
        ...identity,
        resource: 'auth',
        outcome: 'unproven',
        reasonCode: 'process_exit_unproven',
        detailSha256: sha256('external auth authority remains registered after provider release')
      })
    }
    return 'cleanup_pending'
  }
  if (custody.cleanup.auth.state !== 'not_created') {
    custody = input.db.recordCodexLabRuntimeCleanupResult({
      ...identity,
      resource: 'auth',
      outcome: 'released'
    })
  }

  if (
    custody.cleanup.gateway.state !== 'not_created' &&
    !(await releaseResource(input.db, identity, 'gateway', authority.stopGateway))
  ) {
    return 'cleanup_pending'
  }
  custody = input.db.getCodexLabRuntimeCustody(input.dispatchId) ?? custody
  if (
    custody.cleanup.layout.state !== 'not_created' &&
    !(await releaseLayout(input.db, identity, custody, authority.removeLayout))
  ) {
    return 'cleanup_pending'
  }
  input.db.releaseCodexLabRuntimeCustody(identity)
  deleteAuthority(input.dispatchId, authority)
  return 'released'
}

async function releaseLayout(
  db: OrchestrationDb,
  identity: Readonly<{ dispatchId: string; profileId: typeof LAB_READONLY_SUPERVISED_PROFILE_ID }>,
  custody: CodexLabRuntimeCustody,
  release: () => Promise<CodexLabRuntimeLayoutRemovalEvidence>
): Promise<boolean> {
  return releaseResource(db, identity, 'layout', async () => {
    const evidence = await release()
    requireCodexLabRuntimeLayoutRemovalEvidence({
      dispatchRoot: custody.runtimeRoot,
      expectedRootIdentity: custody.runtimeRootIdentity,
      evidence
    })
  })
}

async function releaseResource(
  db: OrchestrationDb,
  identity: Readonly<{ dispatchId: string; profileId: typeof LAB_READONLY_SUPERVISED_PROFILE_ID }>,
  resource: 'gateway' | 'layout',
  release: () => Promise<void>
): Promise<boolean> {
  try {
    await release()
    db.recordCodexLabRuntimeCleanupResult({ ...identity, resource, outcome: 'released' })
    return true
  } catch (error) {
    db.recordCodexLabRuntimeCleanupResult({
      ...identity,
      resource,
      outcome: 'failed',
      reasonCode: 'release_failed',
      detailSha256: sha256(error instanceof Error ? error.message : 'unknown cleanup failure')
    })
    return false
  }
}

function matchesReleasedResource(
  authority: CleanupAuthority,
  resource: WorkerTerminalResourceRow
): boolean {
  return (
    resource.owner_dispatch_id === authority.dispatchId &&
    resource.terminal_handle === authority.terminalHandle &&
    resource.pane_key === authority.terminalPaneKey &&
    resource.process_incarnation === authority.processIncarnation &&
    resource.ownership_state === 'released' &&
    resource.release_state === 'released' &&
    resource.release_completed_at !== null
  )
}

function deleteAuthority(dispatchId: string, authority: CleanupAuthority): boolean {
  if (authorities.get(dispatchId) !== authority) {
    return false
  }
  return authorities.delete(dispatchId)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
