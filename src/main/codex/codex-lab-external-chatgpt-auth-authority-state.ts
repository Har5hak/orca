import {
  CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFRESH_TIMEOUT_MS,
  refuseCodexLabExternalChatGptAuth,
  type CodexLabExternalChatGptAuthBinding,
  type CodexLabExternalChatGptAuthHostFactory,
  type CodexLabExternalChatGptAuthHostPort,
  type CodexLabExternalChatGptCredentialState,
  type CodexLabExternalChatGptLoginParams,
  type CodexLabExternalChatGptRefreshResult,
  type CodexLabExternalChatGptRefreshSource
} from './codex-lab-external-chatgpt-auth-contract'
import {
  assertCodexLabExternalChatGptCredentialFresh,
  assertCodexLabExternalChatGptRefreshRequest,
  exactCodexLabExternalChatGptOwnDataRecord,
  freezeCodexLabExternalChatGptLoginParams,
  freezeCodexLabExternalChatGptRefreshResult,
  sameCodexLabExternalChatGptAuthBinding,
  snapshotCodexLabExternalChatGptAuthBinding,
  snapshotCodexLabExternalChatGptInitialCredential,
  snapshotCodexLabExternalChatGptRefreshCredential
} from './codex-lab-external-chatgpt-auth-validation'

type RuntimeState = {
  readonly binding: CodexLabExternalChatGptAuthBinding
  credential: CodexLabExternalChatGptCredentialState | null
  refreshSource: CodexLabExternalChatGptRefreshSource | null
  phase: 'active' | 'disposed' | 'revoked'
  initialTaken: boolean
  refreshGeneration: number
  inFlight: Promise<CodexLabExternalChatGptRefreshResult> | null
  inFlightAbort: AbortController | null
}

type FactoryState = {
  phase: 'fresh' | 'registered' | 'claimed' | 'minted'
  readonly runtime: RuntimeState
}

const factoryStates = new WeakMap<object, FactoryState>()
const revokedFactories = new WeakSet<object>()
const runtimesByHost = new WeakMap<object, RuntimeState>()

class CodexLabExternalChatGptAuthHost implements CodexLabExternalChatGptAuthHostPort {
  readonly #runtime: RuntimeState

  constructor(runtime: RuntimeState) {
    this.#runtime = runtime
    runtimesByHost.set(this, runtime)
    Object.freeze(this)
  }

  takeInitialLoginParams(): CodexLabExternalChatGptLoginParams {
    const credential = requireActiveCredential(this.#runtime)
    if (this.#runtime.initialTaken) {
      throw refuseCodexLabExternalChatGptAuth('initial_login_replayed')
    }
    assertCodexLabExternalChatGptCredentialFresh(credential)
    this.#runtime.initialTaken = true
    return freezeCodexLabExternalChatGptLoginParams(credential)
  }

  refresh(candidate: unknown): Promise<CodexLabExternalChatGptRefreshResult> {
    const credential = requireActiveCredential(this.#runtime)
    if (!this.#runtime.initialTaken) {
      throw refuseCodexLabExternalChatGptAuth('initial_login_required')
    }
    assertCodexLabExternalChatGptRefreshRequest(candidate, this.#runtime.binding)
    if (this.#runtime.inFlight) {
      return this.#runtime.inFlight
    }
    const source = this.#runtime.refreshSource
    if (!source) {
      throw refuseCodexLabExternalChatGptAuth(
        this.#runtime.phase === 'revoked' ? 'authority_revoked' : 'host_disposed'
      )
    }
    const generation = ++this.#runtime.refreshGeneration
    const abort = new AbortController()
    this.#runtime.inFlightAbort = abort
    const operation = runRefresh(this.#runtime, source, credential, generation, abort)
    this.#runtime.inFlight = operation
    void operation.then(
      () => clearInFlight(this.#runtime, operation, abort),
      () => clearInFlight(this.#runtime, operation, abort)
    )
    return operation
  }

  dispose(): void {
    deactivate(this.#runtime, 'disposed')
  }
}

export function createCodexLabExternalChatGptAuthHostFactory(
  candidate: unknown
): CodexLabExternalChatGptAuthHostFactory {
  const fields = exactCodexLabExternalChatGptOwnDataRecord(candidate, [
    'binding',
    'credential',
    'refresh'
  ])
  if (!fields || typeof fields.refresh !== 'function') {
    throw refuseCodexLabExternalChatGptAuth('authority_invalid')
  }
  const binding = snapshotCodexLabExternalChatGptAuthBinding(fields.binding)
  const credential = snapshotCodexLabExternalChatGptInitialCredential(fields.credential, binding)
  const runtime: RuntimeState = {
    binding,
    credential,
    refreshSource: fields.refresh as CodexLabExternalChatGptRefreshSource,
    phase: 'active',
    initialTaken: false,
    refreshGeneration: 0,
    inFlight: null,
    inFlightAbort: null
  }
  const factory = allocateSecretFreeFactory()
  factoryStates.set(factory, { phase: 'fresh', runtime })
  return factory
}

export function bindCodexLabExternalChatGptAuthHostFactory(
  factory: unknown,
  expected: CodexLabExternalChatGptAuthBinding
): factory is CodexLabExternalChatGptAuthHostFactory {
  const state = frozenFactoryState(factory)
  if (
    state?.phase !== 'fresh' ||
    !sameCodexLabExternalChatGptAuthBinding(state.runtime.binding, expected)
  ) {
    return false
  }
  state.phase = 'registered'
  return true
}

export function claimCodexLabExternalChatGptAuthHostFactory(
  factory: unknown,
  expected: CodexLabExternalChatGptAuthBinding
): CodexLabExternalChatGptAuthHostPort | null {
  const state = frozenFactoryState(factory)
  if (
    typeof factory !== 'function' ||
    state?.phase !== 'registered' ||
    !sameCodexLabExternalChatGptAuthBinding(state.runtime.binding, expected)
  ) {
    return null
  }
  state.phase = 'claimed'
  return factory()
}

export function revokeCodexLabExternalChatGptAuthHostFactory(factory: unknown): void {
  revokeFactory(factory)
}

export function revokeFreshCodexLabExternalChatGptAuthHostFactory(factory: unknown): boolean {
  return revokeFactory(factory, 'fresh')
}

function revokeFactory(factory: unknown, requiredPhase?: FactoryState['phase']): boolean {
  if (typeof factory !== 'function') {
    return false
  }
  const state = factoryStates.get(factory)
  if (!state || (requiredPhase && state.phase !== requiredPhase)) {
    return false
  }
  factoryStates.delete(factory)
  revokedFactories.add(factory)
  deactivate(state.runtime, 'revoked')
  return true
}

function frozenFactoryState(factory: unknown): FactoryState | undefined {
  const state = typeof factory === 'function' ? factoryStates.get(factory) : undefined
  return state && Object.isFrozen(factory) ? state : undefined
}

export function isCodexLabExternalChatGptAuthHostBoundTo(
  host: unknown,
  expected: CodexLabExternalChatGptAuthBinding
): host is CodexLabExternalChatGptAuthHostPort {
  const runtime = host && typeof host === 'object' ? runtimesByHost.get(host) : undefined
  return (
    runtime !== undefined &&
    Object.isFrozen(host) &&
    runtime.phase === 'active' &&
    sameCodexLabExternalChatGptAuthBinding(runtime.binding, expected)
  )
}

async function runRefresh(
  runtime: RuntimeState,
  source: CodexLabExternalChatGptRefreshSource,
  previous: CodexLabExternalChatGptCredentialState,
  generation: number,
  abort: AbortController
): Promise<CodexLabExternalChatGptRefreshResult> {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFRESH_TIMEOUT_MS)
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort.signal.addEventListener(
      'abort',
      () => {
        const reason = timedOut
          ? 'refresh_timeout'
          : runtime.phase === 'revoked'
            ? 'authority_revoked'
            : 'host_disposed'
        reject(refuseCodexLabExternalChatGptAuth(reason))
      },
      { once: true }
    )
  })
  const context = Object.freeze({
    ...runtime.binding,
    reason: 'unauthorized' as const,
    previousAccountId: runtime.binding.workspaceId,
    signal: abort.signal
  })

  let candidate: unknown
  try {
    const sourceOperation = Promise.resolve().then(() => {
      if (
        runtime.phase !== 'active' ||
        runtime.refreshGeneration !== generation ||
        abort.signal.aborted
      ) {
        throw refuseCodexLabExternalChatGptAuth(
          runtime.phase === 'revoked' ? 'authority_revoked' : 'host_disposed'
        )
      }
      return source(context)
    })
    candidate = await Promise.race([sourceOperation, cancellation])
  } catch {
    if (timedOut) {
      throw refuseCodexLabExternalChatGptAuth('refresh_timeout')
    }
    if (runtime.phase === 'revoked') {
      throw refuseCodexLabExternalChatGptAuth('authority_revoked')
    }
    if (runtime.phase === 'disposed') {
      throw refuseCodexLabExternalChatGptAuth('host_disposed')
    }
    throw refuseCodexLabExternalChatGptAuth('refresh_failed')
  } finally {
    clearTimeout(timer)
  }

  if (runtime.phase !== 'active' || runtime.refreshGeneration !== generation) {
    throw refuseCodexLabExternalChatGptAuth(
      runtime.phase === 'revoked' ? 'authority_revoked' : 'host_disposed'
    )
  }
  const next = snapshotCodexLabExternalChatGptRefreshCredential(
    candidate,
    runtime.binding,
    previous.chatgptPlanType
  )
  if (next.accessToken === previous.accessToken) {
    throw refuseCodexLabExternalChatGptAuth('refresh_not_fresh')
  }
  runtime.credential = next
  return freezeCodexLabExternalChatGptRefreshResult(next)
}

function clearInFlight(
  runtime: RuntimeState,
  operation: Promise<CodexLabExternalChatGptRefreshResult>,
  abort: AbortController
): void {
  if (runtime.inFlight === operation) {
    runtime.inFlight = null
  }
  if (runtime.inFlightAbort === abort) {
    runtime.inFlightAbort = null
  }
}

function deactivate(runtime: RuntimeState, phase: 'disposed' | 'revoked'): void {
  if (runtime.phase !== 'active') {
    return
  }
  runtime.phase = phase
  runtime.refreshGeneration += 1
  runtime.inFlightAbort?.abort()
  runtime.credential = null
  runtime.refreshSource = null
}

function requireActiveCredential(runtime: RuntimeState): CodexLabExternalChatGptCredentialState {
  if (runtime.phase !== 'active' || !runtime.credential) {
    throw refuseCodexLabExternalChatGptAuth(
      runtime.phase === 'revoked' ? 'authority_revoked' : 'host_disposed'
    )
  }
  return runtime.credential
}

function allocateSecretFreeFactory(): CodexLabExternalChatGptAuthHostFactory {
  const factory = (): CodexLabExternalChatGptAuthHostPort => mint(factory)
  return Object.freeze(factory)
}

function mint(
  factory: CodexLabExternalChatGptAuthHostFactory
): CodexLabExternalChatGptAuthHostPort {
  const state = factoryStates.get(factory)
  if (state?.phase !== 'claimed') {
    const reason = revokedFactories.has(factory) ? 'authority_revoked' : 'authority_replayed'
    throw refuseCodexLabExternalChatGptAuth(reason)
  }
  state.phase = 'minted'
  return new CodexLabExternalChatGptAuthHost(state.runtime)
}
