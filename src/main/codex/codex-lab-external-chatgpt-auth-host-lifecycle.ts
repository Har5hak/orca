import type {
  CodexLabExternalChatGptAuthBinding,
  CodexLabExternalChatGptAuthHostPort
} from './codex-lab-external-chatgpt-auth-contract'
import { sameCodexLabExternalChatGptAuthBinding } from './codex-lab-external-chatgpt-auth-validation'

type HostState = Readonly<{
  binding: CodexLabExternalChatGptAuthBinding
  phase: 'active' | 'disposed' | 'revoked'
}>

const statesByHost = new WeakMap<object, HostState>()
const disposalCallbacksByHost = new WeakMap<object, () => void>()

export function registerCodexLabExternalChatGptAuthHost(
  host: CodexLabExternalChatGptAuthHostPort,
  state: HostState
): void {
  statesByHost.set(host, state)
}

export function isCodexLabExternalChatGptAuthHostBoundTo(
  host: unknown,
  expected: CodexLabExternalChatGptAuthBinding
): host is CodexLabExternalChatGptAuthHostPort {
  const state = host && typeof host === 'object' ? statesByHost.get(host) : undefined
  return (
    state !== undefined &&
    Object.isFrozen(host) &&
    state.phase === 'active' &&
    sameCodexLabExternalChatGptAuthBinding(state.binding, expected)
  )
}

export function bindCodexLabExternalChatGptAuthHostDisposal(
  host: unknown,
  expected: CodexLabExternalChatGptAuthBinding,
  onDispose: () => void
): host is CodexLabExternalChatGptAuthHostPort {
  if (
    !isCodexLabExternalChatGptAuthHostBoundTo(host, expected) ||
    disposalCallbacksByHost.has(host)
  ) {
    return false
  }
  disposalCallbacksByHost.set(host, onDispose)
  return true
}

export function takeCodexLabExternalChatGptAuthHostDisposal(
  host: CodexLabExternalChatGptAuthHostPort
): (() => void) | undefined {
  const onDispose = disposalCallbacksByHost.get(host)
  disposalCallbacksByHost.delete(host)
  return onDispose
}
