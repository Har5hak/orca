import { describe, expect, it } from 'vitest'
import {
  CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE,
  CodexLabUsageAuthorizationError,
  codexLabCapacityPolicy,
  mintCodexLabUsageAuthorization,
  parseCodexLabUsageAuthorization,
  requireCurrentCodexLabUsageAuthorization,
  serializeCodexLabUsageAuthorization
} from './codex-lab-usage-authorization'

const NOW = Date.parse('2026-09-18T12:00:00.000Z')
const EXPIRY = '2026-09-24T23:00:00.000Z'
const WORKSPACE = '018f47a2-9d72-7cc1-b046-7a2868411f42'

function authorization() {
  return mintCodexLabUsageAuthorization({
    workspaceId: WORKSPACE,
    planType: CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE,
    expiresAt: EXPIRY,
    nowMs: NOW
  })
}

describe('Codex laboratory usage authorization', () => {
  it('persists only the exact workspace hash, plan and absolute expiry', () => {
    const minted = authorization()
    const serialized = serializeCodexLabUsageAuthorization(minted)

    expect(parseCodexLabUsageAuthorization(serialized)).toEqual(minted)
    expect(serialized).not.toContain(WORKSPACE)
    expect(serialized).toContain(CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE)
    expect(Object.isFrozen(minted)).toBe(true)
  })

  it.each([
    ['wrong workspace', { workspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f43' }],
    ['wrong plan', { planType: 'self_serve_business_usage_based' }],
    ['expired', { nowMs: Date.parse(EXPIRY) }]
  ])('refuses a %s binding', (_label, override) => {
    expect(() =>
      requireCurrentCodexLabUsageAuthorization({
        authorization: authorization(),
        workspaceId: WORKSPACE,
        planType: CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE,
        nowMs: NOW,
        ...override
      })
    ).toThrow(CodexLabUsageAuthorizationError)
  })

  it.each([
    ['unsupported plan', { planType: 'self_serve_business_usage_based' }],
    ['expired instant', { expiresAt: '2026-09-18T12:00:00.000Z' }],
    ['non-canonical instant', { expiresAt: '2026-09-24T23:00:00Z' }]
  ])('refuses minting for %s', (_label, override) => {
    expect(() =>
      mintCodexLabUsageAuthorization({
        workspaceId: WORKSPACE,
        planType: CODEX_LAB_AUTHORIZED_METERED_PLAN_TYPE,
        expiresAt: EXPIRY,
        nowMs: NOW,
        ...override
      })
    ).toThrow(CodexLabUsageAuthorizationError)
  })

  it.each([
    '{',
    '{}',
    JSON.stringify({ ...authorization(), futureAuthority: true }),
    JSON.stringify({ ...authorization(), schemaVersion: 2 }),
    JSON.stringify({ ...authorization(), workspaceIdSha256: 'not-a-digest' })
  ])('refuses malformed or broadened persisted authority %#', (serialized) => {
    expect(() => parseCodexLabUsageAuthorization(serialized)).toThrow(
      CodexLabUsageAuthorizationError
    )
  })

  it('keeps included usage on a distinct non-metered policy', () => {
    expect(
      codexLabCapacityPolicy({
        workspaceId: WORKSPACE,
        planType: 'business',
        authorization: null,
        nowMs: NOW
      })
    ).toMatchObject({
      route: 'ordinary-included-only',
      planType: 'business',
      expiresAt: ''
    })
  })
})
