import { describe, expect, it, vi } from 'vitest'
import { prepareCodexLabExternalChatGptAuthRegistration } from './codex-lab-external-chatgpt-auth-registration'
import {
  claimCodexLabExternalChatGptAuthAuthority,
  CodexLabExternalChatGptAuthRegistryRefusal
} from '../runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-resolver'
import { releaseCodexLabExternalChatGptAuthAuthority } from '../runtime/orchestration/lab-profile/codex-lab-external-chatgpt-auth-registry-internal'

const BINDING = Object.freeze({
  dispatchId: 'dispatch-production-auth',
  sessionId: 'session:production-auth',
  workspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f42'
})

describe('Codex lab production external ChatGPT auth registration', () => {
  it('accepts the official null API-key placeholder and cannot roll back after claim', async () => {
    const readCredential = vi.fn(async () => credential({ extra: { OPENAI_API_KEY: null } }))
    const registration = await prepareCodexLabExternalChatGptAuthRegistration({
      ...BINDING,
      source: { readCredential }
    })
    expect(registration.metadata).toEqual({
      workspaceId: BINDING.workspaceId,
      planType: 'business'
    })
    const host = claimCodexLabExternalChatGptAuthAuthority(BINDING)
    expect(host.takeInitialLoginParams()).toEqual({
      type: 'chatgptAuthTokens',
      accessToken: accessToken(),
      chatgptAccountId: BINDING.workspaceId,
      chatgptPlanType: 'business'
    })
    expect(() => claimCodexLabExternalChatGptAuthAuthority(BINDING)).toThrow(
      expect.objectContaining({ reason: 'authority_replayed' })
    )
    expect(registration.rollbackIfUnclaimed()).toBe(false)
    host.dispose()
    expect(releaseCodexLabExternalChatGptAuthAuthority(BINDING.sessionId, BINDING.dispatchId)).toBe(
      true
    )
    expect(readCredential).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['foreign workspace', credential({ workspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f43' })],
    ['personal plan', credential({ planType: 'plus' })],
    ['API key field', credential({ extra: { OPENAI_API_KEY: 'must-not-pass' } })],
    ['non-ChatGPT auth', credential({ authMode: 'personalAccessToken' })]
  ])('refuses %s without publishing authority', async (_case, raw) => {
    await expect(
      prepareCodexLabExternalChatGptAuthRegistration({
        ...BINDING,
        source: { readCredential: async () => raw }
      })
    ).rejects.toThrow(/does not match the launch/i)
    expect(() => claimCodexLabExternalChatGptAuthAuthority(BINDING)).toThrow(
      new CodexLabExternalChatGptAuthRegistryRefusal('authority_missing')
    )
  })

  it('re-reads only on provider refresh and pins the original workspace plan', async () => {
    const readCredential = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(credential())
      .mockResolvedValueOnce(credential({ planType: 'enterprise' }))
    const registration = await prepareCodexLabExternalChatGptAuthRegistration({
      ...BINDING,
      source: { readCredential }
    })
    const host = claimCodexLabExternalChatGptAuthAuthority(BINDING)
    host.takeInitialLoginParams()
    await expect(
      host.refresh({ reason: 'unauthorized', previousAccountId: BINDING.workspaceId })
    ).rejects.toMatchObject({ reason: 'refresh_failed' })
    expect(readCredential).toHaveBeenCalledTimes(2)
    host.dispose()
    expect(registration.rollbackIfUnclaimed()).toBe(false)
    expect(releaseCodexLabExternalChatGptAuthAuthority(BINDING.sessionId, BINDING.dispatchId)).toBe(
      true
    )
  })

  it('rolls back an unclaimed registration idempotently', async () => {
    const registration = await prepareCodexLabExternalChatGptAuthRegistration({
      ...BINDING,
      source: { readCredential: async () => credential() }
    })

    expect(registration.rollbackIfUnclaimed()).toBe(true)
    expect(registration.rollbackIfUnclaimed()).toBe(false)
    expect(() => claimCodexLabExternalChatGptAuthAuthority(BINDING)).toThrow(
      new CodexLabExternalChatGptAuthRegistryRefusal('authority_missing')
    )
  })

  it('derives and pins workspace identity from the single initial source read', async () => {
    const readCredential = vi.fn(async () => credential())
    const registration = await prepareCodexLabExternalChatGptAuthRegistration({
      dispatchId: BINDING.dispatchId,
      sessionId: BINDING.sessionId,
      source: { readCredential }
    })

    expect(registration.binding.workspaceId).toBe(BINDING.workspaceId)
    expect(registration.metadata).toEqual({
      workspaceId: BINDING.workspaceId,
      planType: 'business'
    })
    expect(readCredential).toHaveBeenCalledTimes(1)
    expect(registration.rollbackIfUnclaimed()).toBe(true)
  })
})

function credential(
  options: {
    workspaceId?: string
    planType?: string
    authMode?: string
    extra?: Record<string, unknown>
  } = {}
): string {
  const workspaceId = options.workspaceId ?? BINDING.workspaceId
  return JSON.stringify({
    auth_mode: options.authMode ?? 'chatgpt',
    tokens: {
      access_token: accessToken(),
      id_token: jwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: workspaceId,
          workspace_account_id: workspaceId,
          chatgpt_plan_type: options.planType ?? 'business'
        }
      }),
      refresh_token: 'refresh-secret',
      account_id: workspaceId
    },
    ...options.extra
  })
}

function accessToken(): string {
  return jwt({ exp: Math.floor(Date.now() / 1_000) + 600 })
}

function jwt(payload: Record<string, unknown>): string {
  return ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.')
}
