import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFRESH_TIMEOUT_MS,
  createCodexLabExternalChatGptAuthHostFactory,
  isCodexLabExternalChatGptAuthHostBoundTo,
  type CodexLabExternalChatGptAuthBinding,
  type CodexLabExternalChatGptAuthHostFactory,
  type CodexLabExternalChatGptAuthHostPort,
  type CodexLabExternalChatGptRefreshContext
} from './codex-lab-external-chatgpt-auth-authority'
import { claimCodexLabExternalChatGptAuthHostFactory } from './codex-lab-external-chatgpt-auth-authority-internal'
import {
  registerCodexLabExternalChatGptAuthAuthority,
  releaseCodexLabExternalChatGptAuthAuthority
} from '../runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-registry-internal'
import { claimCodexLabExternalChatGptAuthAuthority } from '../runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-resolver'
import * as publicRegistry from '../runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-registry'

const WORKSPACE_ID = '018f47a2-9d72-7cc1-b046-7a2868411f42'
let sequence = 0
const cleanups: (() => void)[] = []

afterEach(() => {
  vi.useRealTimers()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

describe('Codex laboratory external ChatGPT auth authority', () => {
  it('keeps callable mint authority and credential material off every public registry surface', () => {
    const setup = registerAuthority()
    const metadata = publicRegistry.getCodexLabExternalChatGptAuthMetadata(setup.binding.sessionId)

    expect(Object.keys(publicRegistry).sort()).toEqual([
      'CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REGISTRY_REFUSAL_CODE',
      'CodexLabExternalChatGptAuthRegistryRefusal',
      'getCodexLabExternalChatGptAuthMetadata'
    ])
    expect(metadata).toEqual({
      dispatchId: setup.binding.dispatchId,
      sessionId: setup.binding.sessionId,
      state: 'available'
    })
    expect(metadata).not.toHaveProperty('workspaceId')
    expect(Object.values(metadata ?? {})).not.toContainEqual(expect.any(Function))
    expect(JSON.stringify(metadata)).not.toContain(setup.initialToken)
    expect(JSON.stringify(metadata)).not.toContain(setup.binding.workspaceId)
    expect(JSON.stringify(setup.factory)).toBeUndefined()
    expect(setup.factory.toString()).not.toContain(setup.initialToken)

    const host = claimCodexLabExternalChatGptAuthAuthority(setup.binding)
    expect(JSON.stringify(host)).toBe('{}')
    const claimedMetadata = publicRegistry.getCodexLabExternalChatGptAuthMetadata(
      setup.binding.sessionId
    )
    expect(claimedMetadata).toEqual({
      dispatchId: setup.binding.dispatchId,
      sessionId: setup.binding.sessionId,
      state: 'claimed'
    })
    expect(claimedMetadata).not.toHaveProperty('workspaceId')
    expect(JSON.stringify(claimedMetadata)).not.toContain(setup.binding.workspaceId)

    host.dispose()
  })

  it('returns only the documented chatgptAuthTokens login fields exactly once', () => {
    const setup = registerAuthority()
    const host = claimCodexLabExternalChatGptAuthAuthority(setup.binding)

    expect(host.takeInitialLoginParams()).toEqual({
      type: 'chatgptAuthTokens',
      accessToken: setup.initialToken,
      chatgptAccountId: WORKSPACE_ID,
      chatgptPlanType: 'business'
    })
    expect(() => host.takeInitialLoginParams()).toThrow(/initial_login_replayed/u)
    expect(JSON.stringify(host)).toBe('{}')
  })

  it('revalidates initial-token freshness when login parameters are taken', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'))
    const binding = nextBinding()
    const initialToken = jwt('barely-fresh', Math.floor(Date.now() / 1_000) + 31)
    const factory = createFactory(
      async () => refreshCredential(jwt('unused')),
      binding,
      initialToken
    )
    registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory })
    cleanups.push(() => {
      releaseCodexLabExternalChatGptAuthAuthority(binding.sessionId, binding.dispatchId)
    })
    const host = claimCodexLabExternalChatGptAuthAuthority(binding)

    vi.advanceTimersByTime(2_000)

    expect(() => host.takeInitialLoginParams()).toThrow('credential_not_fresh')
  })

  it.each([
    [
      'api key route',
      (token: string) => ({
        type: 'apiKey',
        accessToken: token,
        chatgptAccountId: WORKSPACE_ID,
        chatgptPlanType: 'business'
      }),
      'credential_invalid'
    ],
    [
      'credential extra field',
      (token: string) => ({
        type: 'chatgptAuthTokens',
        accessToken: token,
        chatgptAccountId: WORKSPACE_ID,
        chatgptPlanType: 'business',
        refreshToken: 'forbidden'
      }),
      'credential_invalid'
    ],
    [
      'consumer plan',
      (token: string) => ({
        type: 'chatgptAuthTokens',
        accessToken: token,
        chatgptAccountId: WORKSPACE_ID,
        chatgptPlanType: 'plus'
      }),
      'credential_invalid'
    ],
    [
      'foreign workspace',
      (token: string) => ({
        type: 'chatgptAuthTokens',
        accessToken: token,
        chatgptAccountId: '018f47a2-9d72-7cc1-b046-7a2868411f43',
        chatgptPlanType: 'business'
      }),
      'credential_invalid'
    ],
    [
      'expired access token',
      () => ({
        type: 'chatgptAuthTokens',
        accessToken: jwt('expired', 1),
        chatgptAccountId: WORKSPACE_ID,
        chatgptPlanType: 'business'
      }),
      'credential_not_fresh'
    ]
  ])('rejects %s before registration', (_label, credential, reason) => {
    const binding = nextBinding()
    const accessToken = jwt('initial')

    expect(() =>
      createCodexLabExternalChatGptAuthHostFactory({
        binding,
        credential: credential(accessToken),
        refresh: async () => refreshCredential(jwt('unused'))
      })
    ).toThrow(reason)
  })

  it('rejects accessors, inherited records, symbols, and non-enumerable credential data', () => {
    const accessTokenGetter = vi.fn(() => jwt('getter'))
    const accessorCredential: Record<string, unknown> = {
      type: 'chatgptAuthTokens',
      chatgptAccountId: WORKSPACE_ID,
      chatgptPlanType: 'business'
    }
    Object.defineProperty(accessorCredential, 'accessToken', {
      enumerable: true,
      get: accessTokenGetter
    })
    const inheritedCredential = Object.assign(
      Object.create({ inherited: true }),
      initialCredential(jwt('inherited'))
    )
    const symbolCredential = initialCredential(jwt('symbol'))
    Object.defineProperty(symbolCredential, Symbol('secret'), {
      value: 'forbidden',
      enumerable: true
    })
    const hiddenCredential = initialCredential(jwt('hidden'))
    Object.defineProperty(hiddenCredential, 'hidden', { value: 'forbidden' })

    for (const credential of [
      accessorCredential,
      inheritedCredential,
      symbolCredential,
      hiddenCredential
    ]) {
      expect(() =>
        createCodexLabExternalChatGptAuthHostFactory({
          binding: nextBinding(),
          credential,
          refresh: async () => refreshCredential(jwt('unused'))
        })
      ).toThrow('credential_invalid')
    }
    expect(accessTokenGetter).not.toHaveBeenCalled()
  })

  it.each([
    ['dispatch traversal', { dispatchId: '..' }],
    ['dispatch delimiter', { dispatchId: 'dispatch:foreign' }],
    ['blank session', { sessionId: '' }],
    ['non-workspace account', { workspaceId: 'org-123' }]
  ])('rejects %s in the authority binding', (_label, override) => {
    const binding = { ...nextBinding(), ...override }
    expect(() =>
      createCodexLabExternalChatGptAuthHostFactory({
        binding,
        credential: initialCredential(jwt('invalid-binding')),
        refresh: async () => refreshCredential(jwt('unused'))
      })
    ).toThrow('binding_invalid')
  })

  it('rejects forged, foreign, and replayed mint authority before a spawn can run', () => {
    const forgedBinding = nextBinding()
    const forgedFactory: CodexLabExternalChatGptAuthHostFactory = Object.freeze(() =>
      Object.freeze({
        takeInitialLoginParams: () => initialCredential(jwt('forged-initial')),
        refresh: async () => refreshCredential(jwt('forged-refresh')),
        dispose() {}
      })
    )
    expect(() =>
      registerCodexLabExternalChatGptAuthAuthority({
        ...forgedBinding,
        factory: forgedFactory
      })
    ).toThrow('authority_invalid')

    const setup = registerAuthority()
    let spawned = false
    expect(() => {
      claimCodexLabExternalChatGptAuthAuthority({
        ...setup.binding,
        dispatchId: `${setup.binding.dispatchId}-foreign`
      })
      spawned = true
    }).toThrow('authority_foreign')
    expect(spawned).toBe(false)
    expect(() => claimCodexLabExternalChatGptAuthAuthority(setup.binding)).toThrow(
      'authority_missing'
    )
    expect(() => setup.factory()).toThrow('authority_revoked')

    const replay = registerAuthority()
    const host = claimCodexLabExternalChatGptAuthAuthority(replay.binding)
    expect(() => claimCodexLabExternalChatGptAuthAuthority(replay.binding)).toThrow(
      'authority_replayed'
    )
    expect(() => replay.factory()).toThrow('authority_replayed')
    host.dispose()
  })

  it('revokes a fresh incoming factory when duplicate registration is rejected', () => {
    const incumbent = registerAuthority()
    const incomingBinding = Object.freeze({
      ...nextBinding(),
      sessionId: incumbent.binding.sessionId
    })
    const incomingFactory = createFactory(
      async () => refreshCredential(jwt('unused')),
      incomingBinding
    )

    expect(() =>
      registerCodexLabExternalChatGptAuthAuthority({ ...incomingBinding, factory: incomingFactory })
    ).toThrow('authority_conflict')
    expect(() => incomingFactory()).toThrow('authority_revoked')

    const incumbentHost = claimCodexLabExternalChatGptAuthAuthority(incumbent.binding)
    expect(isCodexLabExternalChatGptAuthHostBoundTo(incumbentHost, incumbent.binding)).toBe(true)
    incumbentHost.dispose()
  })

  it('revokes a fresh incoming factory after a binding mismatch', () => {
    const factoryBinding = nextBinding()
    const registrationBinding = nextBinding()
    const factory = createFactory(async () => refreshCredential(jwt('unused')), factoryBinding)

    expect(() =>
      registerCodexLabExternalChatGptAuthAuthority({ ...registrationBinding, factory })
    ).toThrow('authority_invalid')
    expect(() => factory()).toThrow('authority_revoked')
  })

  it.each([
    [
      'malformed binding',
      (
        binding: CodexLabExternalChatGptAuthBinding,
        factory: CodexLabExternalChatGptAuthHostFactory
      ) => ({
        ...binding,
        dispatchId: '..',
        factory
      })
    ],
    [
      'extra field',
      (
        binding: CodexLabExternalChatGptAuthBinding,
        factory: CodexLabExternalChatGptAuthHostFactory
      ) => ({
        ...binding,
        factory,
        extra: 'forbidden'
      })
    ],
    [
      'symbol field',
      (
        binding: CodexLabExternalChatGptAuthBinding,
        factory: CodexLabExternalChatGptAuthHostFactory
      ) => {
        const envelope: Record<PropertyKey, unknown> = { ...binding, factory }
        envelope[Symbol('forbidden')] = true
        return envelope
      }
    ]
  ])('revokes a fresh factory from a rejected %s envelope', (_label, envelope) => {
    const binding = nextBinding()
    const factory = createFactory(async () => refreshCredential(jwt('unused')), binding)

    expect(() => registerCodexLabExternalChatGptAuthAuthority(envelope(binding, factory))).toThrow(
      'authority_invalid'
    )
    expect(() => factory()).toThrow('authority_revoked')
  })

  it('does not invoke accessors or consume non-enumerable registration factories', () => {
    const binding = nextBinding()
    const factory = createFactory(async () => refreshCredential(jwt('unused')), binding)
    const factoryGetter = vi.fn(() => factory)
    const accessorEnvelope: Record<PropertyKey, unknown> = { ...binding }
    Object.defineProperty(accessorEnvelope, 'factory', {
      enumerable: true,
      get: factoryGetter
    })
    const hiddenEnvelope: Record<PropertyKey, unknown> = { ...binding }
    Object.defineProperty(hiddenEnvelope, 'factory', {
      enumerable: false,
      value: factory
    })

    expect(() => registerCodexLabExternalChatGptAuthAuthority(accessorEnvelope)).toThrow(
      'authority_invalid'
    )
    expect(() => registerCodexLabExternalChatGptAuthAuthority(hiddenEnvelope)).toThrow(
      'authority_invalid'
    )
    expect(factoryGetter).not.toHaveBeenCalled()

    registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory })
    cleanups.push(() => {
      releaseCodexLabExternalChatGptAuthAuthority(binding.sessionId, binding.dispatchId)
    })
    const host = claimCodexLabExternalChatGptAuthAuthority(binding)
    expect(isCodexLabExternalChatGptAuthHostBoundTo(host, binding)).toBe(true)
    host.dispose()
  })

  it('rejects proxy registration envelopes without invoking their traps or consuming authority', () => {
    const binding = nextBinding()
    const factory = createFactory(async () => refreshCredential(jwt('unused')), binding)
    const get = vi.fn((target: object, property: PropertyKey, receiver: unknown) =>
      Reflect.get(target, property, receiver)
    )
    const getOwnPropertyDescriptor = vi.fn((target: object, property: PropertyKey) =>
      Reflect.getOwnPropertyDescriptor(target, property)
    )
    const getPrototypeOf = vi.fn((target: object) => Reflect.getPrototypeOf(target))
    const ownKeys = vi.fn((target: object) => Reflect.ownKeys(target))
    const envelope = new Proxy(
      { ...binding, factory },
      { get, getOwnPropertyDescriptor, getPrototypeOf, ownKeys }
    )

    expect(() => registerCodexLabExternalChatGptAuthAuthority(envelope)).toThrow(
      'authority_invalid'
    )
    expect(get).not.toHaveBeenCalled()
    expect(getOwnPropertyDescriptor).not.toHaveBeenCalled()
    expect(getPrototypeOf).not.toHaveBeenCalled()
    expect(ownKeys).not.toHaveBeenCalled()

    registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory })
    cleanups.push(() => {
      releaseCodexLabExternalChatGptAuthAuthority(binding.sessionId, binding.dispatchId)
    })
    const host = claimCodexLabExternalChatGptAuthAuthority(binding)
    expect(isCodexLabExternalChatGptAuthHostBoundTo(host, binding)).toBe(true)
    host.dispose()
  })

  it('rejects nested factory and host proxies without invoking traps or leaking raw errors', () => {
    const binding = nextBinding()
    const factory = createFactory(async () => refreshCredential(jwt('unused')), binding)
    const factoryTrap = vi.fn((): never => {
      throw new Error('factory proxy trap secret')
    })
    const factoryProxy = new Proxy(factory, {
      apply: factoryTrap,
      get: factoryTrap,
      getOwnPropertyDescriptor: factoryTrap,
      getPrototypeOf: factoryTrap,
      isExtensible: factoryTrap,
      ownKeys: factoryTrap,
      preventExtensions: factoryTrap
    })

    let rejection: unknown
    try {
      registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory: factoryProxy })
    } catch (error) {
      rejection = error
    }
    expect(rejection).toMatchObject({
      code: publicRegistry.CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REGISTRY_REFUSAL_CODE,
      reason: 'authority_invalid'
    })
    expect(String(rejection)).not.toContain('factory proxy trap secret')
    expect(claimCodexLabExternalChatGptAuthHostFactory(factoryProxy, binding)).toBeNull()
    expect(factoryTrap).not.toHaveBeenCalled()

    registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory })
    cleanups.push(() => {
      releaseCodexLabExternalChatGptAuthAuthority(binding.sessionId, binding.dispatchId)
    })
    const host = claimCodexLabExternalChatGptAuthAuthority(binding)
    const hostTrap = vi.fn((): never => {
      throw new Error('host proxy trap secret')
    })
    const hostProxy = new Proxy(host, {
      getOwnPropertyDescriptor: hostTrap,
      getPrototypeOf: hostTrap,
      isExtensible: hostTrap,
      ownKeys: hostTrap,
      preventExtensions: hostTrap
    })

    expect(isCodexLabExternalChatGptAuthHostBoundTo(hostProxy, binding)).toBe(false)
    expect(hostTrap).not.toHaveBeenCalled()
    expect(isCodexLabExternalChatGptAuthHostBoundTo(host, binding)).toBe(true)
    host.dispose()
  })

  it('cannot revoke registered or claimed incumbent authority through rejected registration', () => {
    const registered = registerAuthority()
    const foreignBinding = nextBinding()

    expect(() =>
      registerCodexLabExternalChatGptAuthAuthority({
        ...registered.binding,
        dispatchId: '..',
        factory: registered.factory
      })
    ).toThrow('authority_invalid')

    expect(() =>
      registerCodexLabExternalChatGptAuthAuthority({
        ...foreignBinding,
        factory: registered.factory
      })
    ).toThrow('authority_invalid')

    const registeredHost = claimCodexLabExternalChatGptAuthAuthority(registered.binding)
    expect(isCodexLabExternalChatGptAuthHostBoundTo(registeredHost, registered.binding)).toBe(true)

    expect(() =>
      registerCodexLabExternalChatGptAuthAuthority({
        ...registered.binding,
        factory: registered.factory,
        extra: 'forbidden'
      })
    ).toThrow('authority_invalid')
    expect(isCodexLabExternalChatGptAuthHostBoundTo(registeredHost, registered.binding)).toBe(true)

    expect(() =>
      registerCodexLabExternalChatGptAuthAuthority({
        ...registered.binding,
        factory: registered.factory
      })
    ).toThrow('authority_conflict')
    expect(isCodexLabExternalChatGptAuthHostBoundTo(registeredHost, registered.binding)).toBe(true)
    registeredHost.dispose()
  })

  it('coalesces concurrent refreshes and exposes no credential to the refresh source context', async () => {
    const nextToken = jwt('next')
    const pending = Promise.withResolvers<unknown>()
    const refresh = vi.fn((_context: CodexLabExternalChatGptRefreshContext) => pending.promise)
    const setup = registerAuthority(refresh)
    const host = claimAndTake(setup)
    const request = refreshRequest()

    const first = host.refresh(request)
    const duplicate = host.refresh({ ...request })

    expect(first).toBe(duplicate)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    const context = refresh.mock.calls[0]?.[0]
    expect(Object.keys(context ?? {}).sort()).toEqual([
      'dispatchId',
      'previousAccountId',
      'reason',
      'sessionId',
      'signal',
      'workspaceId'
    ])
    expect(JSON.stringify(context)).not.toContain(setup.initialToken)
    pending.resolve(refreshCredential(nextToken))

    await expect(first).resolves.toEqual(refreshCredential(nextToken))
    await expect(duplicate).resolves.toEqual(refreshCredential(nextToken))
  })

  it.each([
    ['same token', (initial: string) => refreshCredential(initial), 'refresh_not_fresh'],
    ['expired token', () => refreshCredential(jwt('expired-refresh', 1)), 'credential_not_fresh'],
    [
      'extra field',
      () => ({ ...refreshCredential(jwt('extra')), apiKey: 'forbidden' }),
      'credential_invalid'
    ],
    [
      'login discriminator in refresh result',
      () => ({ ...refreshCredential(jwt('typed')), type: 'chatgptAuthTokens' }),
      'credential_invalid'
    ],
    [
      'foreign account',
      () => ({
        ...refreshCredential(jwt('foreign-account')),
        chatgptAccountId: '018f47a2-9d72-7cc1-b046-7a2868411f43'
      }),
      'credential_invalid'
    ],
    [
      'changed plan',
      () => ({ ...refreshCredential(jwt('changed-plan')), chatgptPlanType: 'enterprise' }),
      'credential_invalid'
    ]
  ])('rejects a %s refresh result', async (_label, result, reason) => {
    const setup = registerAuthority(async () => result(setup.initialToken))
    const host = claimAndTake(setup)

    await expect(host.refresh(refreshRequest())).rejects.toThrow(reason)
  })

  it('validates exact refresh request data before calling the credential source', () => {
    const refresh = vi.fn(async () => refreshCredential(jwt('unused')))
    const setup = registerAuthority(refresh)
    const host = claimAndTake(setup)
    const accessor: Record<string, unknown> = { reason: 'unauthorized' }
    const accountGetter = vi.fn(() => WORKSPACE_ID)
    Object.defineProperty(accessor, 'previousAccountId', {
      enumerable: true,
      get: accountGetter
    })

    expect(() => host.refresh({ ...refreshRequest(), extra: true })).toThrow(
      'refresh_request_invalid'
    )
    expect(() => host.refresh(accessor)).toThrow('refresh_request_invalid')
    expect(() => host.refresh({ reason: 'expired', previousAccountId: WORKSPACE_ID })).toThrow(
      'refresh_request_invalid'
    )
    expect(accountGetter).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('normalizes source failures without reflecting credential material', async () => {
    let secret = ''
    const setup = registerAuthority(async () => {
      throw new Error(`source failed with ${secret}`)
    })
    secret = setup.initialToken
    const host = claimAndTake(setup)

    let caught: unknown
    try {
      await host.refresh(refreshRequest())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ reason: 'refresh_failed' })
    expect(String(caught)).not.toContain(secret)
    expect(JSON.stringify(caught)).not.toContain(secret)
  })

  it('uses a fixed sub-10-second timeout and aborts a non-cooperative refresh', async () => {
    vi.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    const setup = registerAuthority(
      (context) =>
        new Promise<never>(() => {
          observedSignal = context.signal
        })
    )
    const host = claimAndTake(setup)

    expect(CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFRESH_TIMEOUT_MS).toBeLessThan(10_000)
    const pending = host.refresh(refreshRequest())
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(CODEX_LAB_EXTERNAL_CHATGPT_AUTH_REFRESH_TIMEOUT_MS)

    await expect(pending).rejects.toThrow('refresh_timeout')
    expect(observedSignal?.aborted).toBe(true)
  })

  it('disposal rejects in-flight work immediately and ignores a late source result', async () => {
    const pendingSource = Promise.withResolvers<unknown>()
    const setup = registerAuthority(() => pendingSource.promise)
    const host = claimAndTake(setup)
    const pending = host.refresh(refreshRequest())
    await Promise.resolve()

    host.dispose()

    await expect(pending).rejects.toThrow('host_disposed')
    pendingSource.resolve(refreshCredential(jwt('late')))
    await Promise.resolve()
    expect(() => host.takeInitialLoginParams()).toThrow('host_disposed')
    expect(() => host.refresh(refreshRequest())).toThrow('host_disposed')
  })

  it.each([
    [
      'disposal',
      (_setup: AuthoritySetup, host: CodexLabExternalChatGptAuthHostPort) => host.dispose(),
      'host_disposed'
    ],
    [
      'registry revocation',
      (setup: AuthoritySetup) =>
        releaseCodexLabExternalChatGptAuthAuthority(
          setup.binding.sessionId,
          setup.binding.dispatchId
        ),
      'authority_revoked'
    ]
  ])(
    'prevents source invocation when %s wins before the queued refresh',
    async (_label, stop, reason) => {
      const refresh = vi.fn(async () => refreshCredential(jwt('unused')))
      const setup = registerAuthority(refresh)
      const host = claimAndTake(setup)

      const pending = host.refresh(refreshRequest())
      stop(setup, host)

      await expect(pending).rejects.toThrow(reason)
      expect(refresh).not.toHaveBeenCalled()
    }
  )

  it('registry release revokes a claimed host and aborts its in-flight refresh', async () => {
    const pendingSource = Promise.withResolvers<unknown>()
    const setup = registerAuthority(() => pendingSource.promise)
    const host = claimAndTake(setup)
    const pending = host.refresh(refreshRequest())
    await Promise.resolve()

    expect(
      releaseCodexLabExternalChatGptAuthAuthority(setup.binding.sessionId, setup.binding.dispatchId)
    ).toBe(true)

    await expect(pending).rejects.toThrow('authority_revoked')
    pendingSource.resolve(refreshCredential(jwt('late-revoked')))
    await Promise.resolve()
    expect(() => host.refresh(refreshRequest())).toThrow('authority_revoked')
    expect(isCodexLabExternalChatGptAuthHostBoundTo(host, setup.binding)).toBe(false)
  })
})

type AuthoritySetup = Readonly<{
  binding: CodexLabExternalChatGptAuthBinding
  initialToken: string
  factory: CodexLabExternalChatGptAuthHostFactory
}>

function registerAuthority(
  refresh: (
    context: Parameters<Parameters<typeof createFactory>[0]>[0]
  ) => Promise<unknown> = async () => refreshCredential(jwt('default-next'))
): AuthoritySetup {
  const binding = nextBinding()
  const initialToken = jwt(`initial-${sequence}`)
  const factory = createFactory(refresh, binding, initialToken)
  registerCodexLabExternalChatGptAuthAuthority({ ...binding, factory })
  cleanups.push(() => {
    releaseCodexLabExternalChatGptAuthAuthority(binding.sessionId, binding.dispatchId)
  })
  return Object.freeze({ binding, initialToken, factory })
}

function createFactory(
  refresh: (context: CodexLabExternalChatGptRefreshContext) => Promise<unknown>,
  binding = nextBinding(),
  initialToken = jwt(`initial-${sequence}`)
) {
  return createCodexLabExternalChatGptAuthHostFactory({
    binding,
    credential: initialCredential(initialToken),
    refresh
  })
}

function claimAndTake(setup: AuthoritySetup): CodexLabExternalChatGptAuthHostPort {
  const host = claimCodexLabExternalChatGptAuthAuthority(setup.binding)
  host.takeInitialLoginParams()
  return host
}

function nextBinding(): CodexLabExternalChatGptAuthBinding {
  sequence += 1
  return Object.freeze({
    dispatchId: `dispatch-757-auth-${sequence}`,
    sessionId: `session-757-auth-${sequence}`,
    workspaceId: WORKSPACE_ID
  })
}

function initialCredential(accessToken: string) {
  return {
    type: 'chatgptAuthTokens' as const,
    accessToken,
    chatgptAccountId: WORKSPACE_ID,
    chatgptPlanType: 'business'
  }
}

function refreshCredential(accessToken: string) {
  return {
    accessToken,
    chatgptAccountId: WORKSPACE_ID,
    chatgptPlanType: 'business'
  }
}

function refreshRequest() {
  return { reason: 'unauthorized', previousAccountId: WORKSPACE_ID } as const
}

function jwt(label: string, expiresAtSeconds = Math.floor(Date.now() / 1_000) + 3_600): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ exp: expiresAtSeconds, label })).toString(
    'base64url'
  )
  const signature = Buffer.from(label).toString('base64url') || 'x'
  return `${header}.${payload}.${signature}`
}
