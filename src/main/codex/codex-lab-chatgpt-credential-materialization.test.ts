import { describe, expect, it } from 'vitest'
import {
  CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE,
  codexAuthKeyringAccount,
  materializeCodexLabChatGptCredential,
  type CodexLabCredentialMaterializationPorts
} from './codex-lab-chatgpt-credential-materialization'

const TARGET_HOME = '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-canary-1/codex-home'
const DISPATCH_ID = 'dispatch-757-canary-1'
const WORKSPACE_ID = '018f47a2-9d72-7cc1-b046-7a2868411f42'
const PLAN_TYPE = 'business'

function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(
    JSON.stringify({
      email: 'worker@example.com',
      'https://api.openai.com/auth': claims
    })
  ).toString('base64url')
  return `header.${payload}.signature`
}

function chatGptCredential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access-secret',
      id_token: jwt({
        chatgpt_account_id: WORKSPACE_ID,
        workspace_account_id: WORKSPACE_ID,
        chatgpt_plan_type: PLAN_TYPE
      }),
      refresh_token: 'refresh-secret',
      account_id: WORKSPACE_ID
    },
    ...overrides
  })
}

type PortHarness = {
  ports: CodexLabCredentialMaterializationPorts
  events: string[]
  writes: { service: string; account: string; secret: string }[]
  deletes: { service: string; account: string }[]
}

function portHarness(
  source: string | null,
  options: {
    writeError?: boolean
    deleteError?: boolean
  } = {}
): PortHarness {
  const events: string[] = []
  const writes: PortHarness['writes'] = []
  const deletes: PortHarness['deletes'] = []
  return {
    events,
    writes,
    deletes,
    ports: {
      source: {
        async readCredential() {
          events.push('source:read')
          return source
        }
      },
      targetKeyring: {
        async replaceAndVerifyCredential(entry) {
          events.push('target:replace-and-verify')
          writes.push(entry)
          if (options.writeError) {
            throw new Error('write failed with access-secret')
          }
        },
        async deleteCredential(locator) {
          events.push('target:delete')
          deletes.push(locator)
          if (options.deleteError) {
            throw new Error('delete failed with access-secret')
          }
        }
      }
    }
  }
}

function request(
  overrides: Partial<Parameters<typeof materializeCodexLabChatGptCredential>[0]> = {}
) {
  return {
    dispatchId: DISPATCH_ID,
    canonicalTargetCodexHome: TARGET_HOME,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedPlanType: PLAN_TYPE,
    ...overrides
  }
}

describe('Codex laboratory ChatGPT credential materialization', () => {
  it('derives the official target account from the canonical CODEX_HOME', () => {
    expect(codexAuthKeyringAccount(TARGET_HOME)).toBe('cli|22d31d54a74f31bf')
  })

  it.each([
    [
      'another dispatch home',
      { dispatchId: 'dispatch-758', canonicalTargetCodexHome: TARGET_HOME }
    ],
    ['a non-lab home', { canonicalTargetCodexHome: '/Users/operator/.codex' }]
  ])('refuses %s before reading or mutating credentials', async (_label, overrides) => {
    const harness = portHarness(chatGptCredential())

    await expect(
      materializeCodexLabChatGptCredential(request(overrides), harness.ports)
    ).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE,
      data: { reason: 'target_home_invalid' }
    })
    expect(harness.events).toEqual([])
  })

  it('writes and verifies ChatGPT auth while returning only non-secret receipt metadata', async () => {
    const source = chatGptCredential()
    const harness = portHarness(source)

    const receipt = await materializeCodexLabChatGptCredential(request(), harness.ports)

    expect(harness.events).toEqual(['source:read', 'target:replace-and-verify'])
    expect(harness.writes).toEqual([
      {
        service: 'Codex Auth',
        account: 'cli|22d31d54a74f31bf',
        secret: source
      }
    ])
    expect(receipt).toEqual({
      schemaVersion: 1,
      status: 'materialized',
      store: 'keyring',
      service: 'Codex Auth',
      account: 'cli|22d31d54a74f31bf',
      loginMethod: 'chatgpt',
      workspaceVerified: true,
      planVerified: true,
      readbackVerified: true
    })
    expect(JSON.stringify(receipt)).not.toMatch(/access-secret|refresh-secret|worker@example\.com/)
  })

  it.each([
    ['API key', { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test' }],
    ['personal access token', { auth_mode: 'personalAccessToken', personal_access_token: 'pat' }],
    [
      'Bedrock API key',
      { auth_mode: 'bedrockApiKey', bedrock_api_key: { api_key: 'bedrock-secret' } }
    ]
  ])('rejects %s auth and removes any target residue', async (_label, credential) => {
    const harness = portHarness(JSON.stringify(credential))

    await expect(
      materializeCodexLabChatGptCredential(request(), harness.ports)
    ).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE,
      data: { reason: 'auth_method_unsupported' }
    })
    expect(harness.writes).toHaveLength(0)
    expect(harness.deletes).toEqual([{ service: 'Codex Auth', account: 'cli|22d31d54a74f31bf' }])
  })

  it.each([
    [
      'workspace',
      { expectedWorkspaceId: '018f47a2-9d72-7cc1-b046-7a2868411f43' },
      'workspace_mismatch'
    ],
    ['plan', { expectedPlanType: 'enterprise' }, 'plan_mismatch']
  ] as const)(
    'rejects a mismatched expected %s before writing',
    async (_label, overrides, reason) => {
      const harness = portHarness(chatGptCredential())

      await expect(
        materializeCodexLabChatGptCredential(request(overrides), harness.ports)
      ).rejects.toMatchObject({
        code: CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE,
        data: { reason }
      })
      expect(harness.writes).toHaveLength(0)
      expect(harness.events).toEqual(['source:read', 'target:delete'])
    }
  )

  it('deletes the target when native replacement or internal verification fails', async () => {
    const harness = portHarness(chatGptCredential(), { writeError: true })

    await expect(
      materializeCodexLabChatGptCredential(request(), harness.ports)
    ).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE,
      data: { reason: 'target_write_failed' }
    })
    expect(harness.events).toEqual(['source:read', 'target:replace-and-verify', 'target:delete'])
    expect(harness.deletes).toEqual([{ service: 'Codex Auth', account: 'cli|22d31d54a74f31bf' }])
  })

  it('sanitizes combined replacement/verification failures and reports failed cleanup', async () => {
    const harness = portHarness(chatGptCredential(), { writeError: true, deleteError: true })

    const failure = materializeCodexLabChatGptCredential(request(), harness.ports)
    await expect(failure).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_MATERIALIZATION_REFUSAL_CODE,
      data: { reason: 'target_cleanup_failed' }
    })
    await expect(failure).rejects.not.toThrow(/access-secret|refresh-secret/)
    expect(harness.events).toEqual(['source:read', 'target:replace-and-verify', 'target:delete'])
  })
})
