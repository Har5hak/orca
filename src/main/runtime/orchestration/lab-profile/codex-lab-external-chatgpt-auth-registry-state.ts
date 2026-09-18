import { types as nodeUtilTypes } from 'node:util'
import {
  isCodexLabExternalChatGptAuthHostBoundTo,
  type CodexLabExternalChatGptAuthBinding,
  type CodexLabExternalChatGptAuthHostFactory,
  type CodexLabExternalChatGptAuthHostPort
} from '../../../codex/codex-lab-external-chatgpt-auth-authority'
import {
  bindCodexLabExternalChatGptAuthHostFactory,
  claimCodexLabExternalChatGptAuthHostFactory,
  revokeFreshCodexLabExternalChatGptAuthHostFactory,
  revokeCodexLabExternalChatGptAuthHostFactory
} from '../../../codex/codex-lab-external-chatgpt-auth-authority-internal'
import { snapshotCodexLabExternalChatGptAuthBinding } from '../../../codex/codex-lab-external-chatgpt-auth-validation'
import { exactCodexLabExternalChatGptOwnDataRecord } from '../../../codex/codex-lab-external-chatgpt-auth-validation'

export const CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REGISTRY_REFUSAL_CODE =
  'ORCA_CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REGISTRY_REFUSED' as const

export type CodexLabExternalChatGptAuthRegistration = Readonly<
  CodexLabExternalChatGptAuthBinding & {
    factory: CodexLabExternalChatGptAuthHostFactory
  }
>

export type CodexLabExternalChatGptAuthMetadata = Readonly<{
  dispatchId: string
  sessionId: string
  state: 'available' | 'claimed'
}>

export class CodexLabExternalChatGptAuthRegistryRefusal extends Error {
  readonly code = CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REGISTRY_REFUSAL_CODE

  constructor(
    readonly reason:
      | 'authority_conflict'
      | 'authority_foreign'
      | 'authority_invalid'
      | 'authority_missing'
      | 'authority_replayed'
  ) {
    super(`Codex laboratory external ChatGPT auth registry refused: ${reason}`)
    this.name = 'CodexLabExternalChatGptAuthRegistryRefusal'
  }
}

type RegistryEntry = {
  readonly binding: CodexLabExternalChatGptAuthBinding
  readonly factory: CodexLabExternalChatGptAuthHostFactory
  state: 'available' | 'claimed'
}

const entriesBySessionId = new Map<string, RegistryEntry>()

export function registerCodexLabExternalChatGptAuthAuthority(
  candidate: unknown
): CodexLabExternalChatGptAuthMetadata {
  const rejectedFactory = ownEnumerableRegistrationFactory(candidate)
  let registration: ReturnType<typeof snapshotRegistration>
  try {
    registration = snapshotRegistration(candidate)
  } catch (error) {
    revokeFreshCodexLabExternalChatGptAuthHostFactory(rejectedFactory)
    throw error
  }
  const { binding, factory } = registration
  if (entriesBySessionId.has(binding.sessionId)) {
    revokeFreshCodexLabExternalChatGptAuthHostFactory(factory)
    throw refusal('authority_conflict')
  }
  if (!bindCodexLabExternalChatGptAuthHostFactory(factory, binding)) {
    revokeFreshCodexLabExternalChatGptAuthHostFactory(factory)
    throw refusal('authority_invalid')
  }
  const entry: RegistryEntry = {
    binding,
    factory,
    state: 'available'
  }
  entriesBySessionId.set(binding.sessionId, entry)
  return metadata(entry)
}

export function getCodexLabExternalChatGptAuthMetadata(
  sessionId: string
): CodexLabExternalChatGptAuthMetadata | undefined {
  const entry = entriesBySessionId.get(sessionId)
  return entry ? metadata(entry) : undefined
}

export function claimCodexLabExternalChatGptAuthAuthority(
  expected: CodexLabExternalChatGptAuthBinding
): CodexLabExternalChatGptAuthHostPort {
  const binding = snapshotBinding(expected)
  const entry = entriesBySessionId.get(binding.sessionId)
  if (!entry) {
    throw refusal('authority_missing')
  }
  if (entry.state !== 'available') {
    throw refusal('authority_replayed')
  }
  if (!sameBinding(entry.binding, binding)) {
    revokeCodexLabExternalChatGptAuthHostFactory(entry.factory)
    entriesBySessionId.delete(binding.sessionId)
    throw refusal('authority_foreign')
  }
  const host = claimCodexLabExternalChatGptAuthHostFactory(entry.factory, binding)
  if (!host || !isCodexLabExternalChatGptAuthHostBoundTo(host, binding)) {
    revokeCodexLabExternalChatGptAuthHostFactory(entry.factory)
    entriesBySessionId.delete(binding.sessionId)
    throw refusal('authority_invalid')
  }
  entry.state = 'claimed'
  return host
}

export function releaseCodexLabExternalChatGptAuthAuthority(
  sessionId: string,
  dispatchId: string
): boolean {
  const entry = entriesBySessionId.get(sessionId)
  if (!entry || entry.binding.dispatchId !== dispatchId) {
    return false
  }
  if (!entriesBySessionId.delete(sessionId)) {
    return false
  }
  revokeCodexLabExternalChatGptAuthHostFactory(entry.factory)
  return true
}

/** Rolls back only an authority that has not transferred to the provider launch. */
export function releaseCodexLabExternalChatGptAuthAuthorityIfUnclaimed(
  sessionId: string,
  dispatchId: string
): boolean {
  const entry = entriesBySessionId.get(sessionId)
  if (!entry || entry.state !== 'available' || entry.binding.dispatchId !== dispatchId) {
    return false
  }
  if (!entriesBySessionId.delete(sessionId)) {
    return false
  }
  revokeCodexLabExternalChatGptAuthHostFactory(entry.factory)
  return true
}

function snapshotBinding(candidate: CodexLabExternalChatGptAuthBinding) {
  return snapshotCodexLabExternalChatGptAuthBinding(candidate)
}

function snapshotRegistration(candidate: unknown): Readonly<{
  binding: CodexLabExternalChatGptAuthBinding
  factory: CodexLabExternalChatGptAuthHostFactory
}> {
  if (nodeUtilTypes.isProxy(candidate)) {
    throw refusal('authority_invalid')
  }
  const fields = exactCodexLabExternalChatGptOwnDataRecord(candidate, [
    'dispatchId',
    'sessionId',
    'workspaceId',
    'factory'
  ])
  if (!fields || typeof fields.factory !== 'function') {
    throw refusal('authority_invalid')
  }
  let binding: CodexLabExternalChatGptAuthBinding
  try {
    binding = snapshotCodexLabExternalChatGptAuthBinding({
      dispatchId: fields.dispatchId,
      sessionId: fields.sessionId,
      workspaceId: fields.workspaceId
    })
  } catch {
    throw refusal('authority_invalid')
  }
  return Object.freeze({
    binding,
    factory: fields.factory as CodexLabExternalChatGptAuthHostFactory
  })
}

function ownEnumerableRegistrationFactory(candidate: unknown): unknown {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate) ||
    nodeUtilTypes.isProxy(candidate)
  ) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, 'factory')
    return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function metadata(entry: RegistryEntry): CodexLabExternalChatGptAuthMetadata {
  return Object.freeze({
    dispatchId: entry.binding.dispatchId,
    sessionId: entry.binding.sessionId,
    state: entry.state
  })
}

function sameBinding(
  actual: CodexLabExternalChatGptAuthBinding,
  expected: CodexLabExternalChatGptAuthBinding
): boolean {
  return (
    actual.dispatchId === expected.dispatchId &&
    actual.sessionId === expected.sessionId &&
    actual.workspaceId === expected.workspaceId
  )
}

function refusal(
  reason: ConstructorParameters<typeof CodexLabExternalChatGptAuthRegistryRefusal>[0]
): CodexLabExternalChatGptAuthRegistryRefusal {
  return new CodexLabExternalChatGptAuthRegistryRefusal(reason)
}
