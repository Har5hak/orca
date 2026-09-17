import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
  createCodexLabChatGptCredentialHostPorts,
  resolveSelectedHostCodexCredentialSource,
  type CodexLabSecurityCommandExecutor,
  type CodexLabSecurityCommandRequest,
  type CodexLabSecurityCommandResult,
  type SelectedHostCodexCredentialSource
} from './codex-lab-chatgpt-credential-host-ports'
import {
  CODEX_AUTH_KEYRING_SERVICE,
  codexAuthKeyringAccount,
  materializeCodexLabChatGptCredential
} from './codex-lab-chatgpt-credential-materialization'

const SOURCE_HOME = '/Users/operator/.codex'
const MANAGED_HOME = '/Users/operator/Library/Application Support/orca/codex-accounts/a/home'
const TARGET_HOME = '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-host-port/codex-home'
const TARGET_AUTH_JSON = `${TARGET_HOME}/auth.json`
const DISPATCH_ID = 'dispatch-757-host-port'
const WORKSPACE_ID = '018f47a2-9d72-7cc1-b046-7a2868411f42'
const PLAN_TYPE = 'business'

type SelectionSettings = Parameters<typeof resolveSelectedHostCodexCredentialSource>[0]['settings']

function jwt(claims: Record<string, unknown>): string {
  const payload = Buffer.from(
    JSON.stringify({
      email: 'worker@example.com',
      'https://api.openai.com/auth': claims
    })
  ).toString('base64url')
  return `header.${payload}.signature`
}

function credential(marker = 'source', pretty = false): string {
  return JSON.stringify(
    {
      auth_mode: 'chatgpt',
      tokens: {
        access_token: `access-secret-${marker}`,
        id_token: jwt({
          chatgpt_account_id: WORKSPACE_ID,
          workspace_account_id: WORKSPACE_ID,
          chatgpt_plan_type: PLAN_TYPE
        }),
        refresh_token: `refresh-secret-${marker}`,
        account_id: WORKSPACE_ID
      }
    },
    null,
    pretty ? 2 : undefined
  )
}

function settings(overrides: Partial<SelectionSettings> = {}): SelectionSettings {
  return {
    activeCodexManagedAccountId: null,
    activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} },
    codexManagedAccounts: [],
    ...overrides
  }
}

function source(
  storage: SelectedHostCodexCredentialSource['storage'] = 'file',
  canonicalCodexHome = SOURCE_HOME
): SelectedHostCodexCredentialSource {
  return { storage, canonicalCodexHome, selectedAccountId: null }
}

function processResult(
  overrides: Partial<CodexLabSecurityCommandResult> = {}
): CodexLabSecurityCommandResult {
  return {
    code: 0,
    timedOut: false,
    outputTruncated: false,
    stdout: '',
    stderr: '',
    ...overrides
  }
}

function targetLocator() {
  return {
    service: CODEX_AUTH_KEYRING_SERVICE,
    account: codexAuthKeyringAccount(TARGET_HOME)
  }
}

function request() {
  return {
    dispatchId: DISPATCH_ID,
    canonicalTargetCodexHome: TARGET_HOME,
    expectedWorkspaceId: WORKSPACE_ID,
    expectedPlanType: PLAN_TYPE
  }
}

describe('Codex laboratory ChatGPT credential host ports', () => {
  it('resolves the current host selection instead of borrowing another account lane', () => {
    const assertManagedHome = vi.fn(() => MANAGED_HOME)
    const selected = resolveSelectedHostCodexCredentialSource(
      {
        settings: settings({
          activeCodexManagedAccountId: 'a',
          activeCodexManagedAccountIdsByRuntime: {
            host: 'a',
            wsl: { ubuntu: 'wsl-account' }
          },
          codexManagedAccounts: [
            {
              id: 'a',
              email: 'a@example.com',
              managedHomePath: MANAGED_HOME,
              managedHomeRuntime: 'host',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'wsl-account',
              email: 'wsl@example.com',
              managedHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\worker\\.codex',
              managedHomeRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ]
        }),
        storage: 'file',
        systemCodexHomePath: SOURCE_HOME
      },
      { assertManagedHome }
    )

    expect(selected).toEqual({
      storage: 'file',
      canonicalCodexHome: MANAGED_HOME,
      selectedAccountId: 'a'
    })
    expect(assertManagedHome).toHaveBeenCalledExactlyOnceWith(MANAGED_HOME, 'a')
  })

  it('uses the canonical system-default home when the host lane selects no managed account', () => {
    const canonicalizeSystemHome = vi.fn(() => '/private/Users/operator/.codex')

    const selected = resolveSelectedHostCodexCredentialSource(
      {
        settings: settings(),
        storage: 'keyring',
        systemCodexHomePath: SOURCE_HOME
      },
      { canonicalizeSystemHome }
    )

    expect(selected).toEqual({
      storage: 'keyring',
      canonicalCodexHome: '/private/Users/operator/.codex',
      selectedAccountId: null
    })
    expect(canonicalizeSystemHome).toHaveBeenCalledExactlyOnceWith(SOURCE_HOME)
  })

  it('fails closed when the persisted host selection is missing or belongs to WSL', () => {
    const invalidSettings = settings({
      activeCodexManagedAccountId: 'missing',
      activeCodexManagedAccountIdsByRuntime: { host: 'missing', wsl: {} }
    })

    expect(() =>
      resolveSelectedHostCodexCredentialSource({
        settings: invalidSettings,
        storage: 'file',
        systemCodexHomePath: SOURCE_HOME
      })
    ).toThrow(
      expect.objectContaining({
        code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
        data: { operation: 'source_selection', reason: 'selected_account_invalid' }
      })
    )
  })

  it('reads a file-backed selected credential and never invokes Keychain', async () => {
    const secret = credential('file', true)
    const readCredentialFile = vi.fn(async () => secret)
    const executeSecurityCommand = vi.fn(() => {
      throw new Error('Keychain must not be used for a file source')
    })
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source('file', MANAGED_HOME), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand,
        readCredentialFile,
        observeTargetAuthJson: async () => 'absent'
      }
    )

    await expect(ports.source.readCredential()).resolves.toBe(JSON.stringify(JSON.parse(secret)))
    expect(readCredentialFile).toHaveBeenCalledExactlyOnceWith(`${MANAGED_HOME}/auth.json`)
    expect(executeSecurityCommand).not.toHaveBeenCalled()
  })

  it('reads the exact official Codex Auth item for a keyring-backed selected source', async () => {
    const secret = credential('keyring')
    const calls: CodexLabSecurityCommandRequest[] = []
    const executeSecurityCommand: CodexLabSecurityCommandExecutor = async (command) => {
      calls.push(command)
      return processResult({ stdout: `${secret}\n` })
    }
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source('keyring'), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand,
        readCredentialFile: async () => {
          throw new Error('auth.json must not be read for a keyring source')
        },
        observeTargetAuthJson: async () => 'absent'
      }
    )

    await expect(ports.source.readCredential()).resolves.toBe(secret)
    expect(calls).toEqual([
      {
        program: '/usr/bin/security',
        args: ['find-generic-password', '-s', 'Codex Auth', '-a', 'cli|015e728347e91c37', '-w']
      }
    ])
  })

  it('reads only the exact official target item and verifies auth.json remains absent', async () => {
    const calls: CodexLabSecurityCommandRequest[] = []
    const observations: string[] = []
    const executeSecurityCommand: CodexLabSecurityCommandExecutor = async (command) => {
      calls.push(command)
      return processResult({ stdout: `${credential('target-read')}\n` })
    }
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source(), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand,
        observeTargetAuthJson: async (filePath) => {
          observations.push(filePath)
          return 'absent'
        }
      }
    )

    await expect(ports.targetKeyring.readCredential(targetLocator())).resolves.toBe(
      credential('target-read')
    )
    expect(observations).toEqual([TARGET_AUTH_JSON, TARGET_AUTH_JSON])
    expect(calls.map((call) => call.args)).toEqual([
      ['find-generic-password', '-s', 'Codex Auth', '-a', 'cli|d6dd9eb51bbae437', '-w']
    ])
  })

  it('refuses target writes without a native writer and never sends a secret to a command', async () => {
    const executeSecurityCommand = vi.fn(async () => processResult())
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source(), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand,
        observeTargetAuthJson: async () => 'absent'
      }
    )

    await expect(
      ports.targetKeyring.writeCredential({
        ...targetLocator(),
        secret: credential('must-never-enter-argv')
      })
    ).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'target_write', reason: 'secure_keyring_write_unavailable' }
    })
    expect(executeSecurityCommand).not.toHaveBeenCalled()
  })

  it('runs exact target cleanup when fail-closed writing aborts materialization', async () => {
    const calls: CodexLabSecurityCommandRequest[] = []
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source(), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand: async (command) => {
          calls.push(command)
          return processResult()
        },
        readCredentialFile: async () => credential('unavailable-writer'),
        observeTargetAuthJson: async () => 'absent'
      }
    )

    await expect(materializeCodexLabChatGptCredential(request(), ports)).rejects.toMatchObject({
      data: { reason: 'target_write_failed' }
    })
    expect(calls.map((call) => call.args)).toEqual([
      ['delete-generic-password', '-s', 'Codex Auth', '-a', 'cli|d6dd9eb51bbae437']
    ])
    expect(JSON.stringify(calls)).not.toMatch(/access-secret|refresh-secret/)
  })

  it('sanitizes command failures even when rejected output contains credentials', async () => {
    const leaked = credential('must-not-leak')
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source('keyring'), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand: async () => {
          throw new Error(`security failed with ${leaked}`)
        },
        observeTargetAuthJson: async () => 'absent'
      }
    )

    const failure = ports.source.readCredential()
    await expect(failure).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'source_read', reason: 'keyring_command_failed' }
    })
    await expect(failure).rejects.not.toThrow(/access-secret|refresh-secret/)
  })

  it('does not treat truncated Keychain output as a missing credential', async () => {
    const leaked = credential('truncated-output')
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source('keyring'), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand: async () =>
          processResult({ code: 44, outputTruncated: true, stderr: leaked }),
        observeTargetAuthJson: async () => 'absent'
      }
    )

    const failure = ports.source.readCredential()
    await expect(failure).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'source_read', reason: 'keyring_command_failed' }
    })
    await expect(failure).rejects.not.toThrow(/access-secret|refresh-secret/)
  })

  it('refuses target auth.json residue before write without invoking Keychain', async () => {
    const executeSecurityCommand = vi.fn(async () => processResult())
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source(), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand,
        readCredentialFile: async () => credential(),
        observeTargetAuthJson: async () => 'present'
      }
    )

    await expect(
      ports.targetKeyring.writeCredential({ ...targetLocator(), secret: credential() })
    ).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'target_write', reason: 'target_auth_json_present' }
    })
    expect(executeSecurityCommand).not.toHaveBeenCalled()
  })

  it('still deletes Keychain residue before reporting target auth.json found during cleanup', async () => {
    const calls: CodexLabSecurityCommandRequest[] = []
    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source(), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand: async (command) => {
          calls.push(command)
          return processResult()
        },
        observeTargetAuthJson: async () => 'present'
      }
    )

    await expect(ports.targetKeyring.deleteCredential(targetLocator())).rejects.toMatchObject({
      data: { operation: 'target_delete', reason: 'target_auth_json_present' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0]).toBe('delete-generic-password')
  })

  it('rejects a broadened locator and unsupported hosts without touching either store', async () => {
    const executeSecurityCommand = vi.fn(async () => processResult())
    expect(() =>
      createCodexLabChatGptCredentialHostPorts(
        { source: source(), canonicalTargetCodexHome: TARGET_HOME },
        { platform: 'linux', executeSecurityCommand }
      )
    ).toThrow(
      expect.objectContaining({
        data: { operation: 'source_selection', reason: 'platform_unsupported' }
      })
    )

    const ports = createCodexLabChatGptCredentialHostPorts(
      { source: source(), canonicalTargetCodexHome: TARGET_HOME },
      {
        platform: 'darwin',
        executeSecurityCommand,
        observeTargetAuthJson: async () => 'absent'
      }
    )
    await expect(
      ports.targetKeyring.readCredential({ service: 'Codex Auth', account: 'cli|wrong' })
    ).rejects.toMatchObject({
      data: { operation: 'target_read', reason: 'keyring_locator_mismatch' }
    })
    expect(executeSecurityCommand).not.toHaveBeenCalled()
  })
})
