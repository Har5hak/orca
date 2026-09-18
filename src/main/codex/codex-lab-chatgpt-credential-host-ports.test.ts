import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
  CodexLabCredentialHostPortRefusal,
  createCodexLabChatGptCredentialHostPorts,
  resolveSelectedHostCodexCredentialSource,
  type CodexLabKeychainWriterRequest,
  type SelectedHostCodexCredentialSource
} from './codex-lab-chatgpt-credential-host-ports'
import {
  CODEX_AUTH_KEYRING_SERVICE,
  codexAuthKeyringAccount,
  materializeCodexLabChatGptCredential
} from './codex-lab-chatgpt-credential-materialization'
import {
  deleteKeyringCredentialWithWriter,
  installKeyringCredentialWithWriter,
  resolveCodexLabKeychainWriterPath
} from './codex-lab-chatgpt-credential-host-storage'

const SOURCE_HOME = '/Users/operator/.codex'
const MANAGED_HOME = '/Users/operator/Library/Application Support/orca/codex-accounts/a/home'
const TARGET_HOME = '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-host-port/codex-home'
const TARGET_AUTH_JSON = `${TARGET_HOME}/auth.json`
const DISPATCH_ID = 'dispatch-757-host-port'
const WORKSPACE_ID = '018f47a2-9d72-7cc1-b046-7a2868411f42'
const PLAN_TYPE = 'business'
const KEYCHAIN_WRITER = '/Applications/Orca.app/Contents/MacOS/orca-codex-lab-keychain-writer'

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

function hostArgs(selectedSource: SelectedHostCodexCredentialSource = source()) {
  return {
    source: selectedSource,
    dispatchId: DISPATCH_ID,
    canonicalTargetCodexHome: TARGET_HOME,
    launchPlan: {
      dispatchId: DISPATCH_ID,
      executable: '/Applications/ChatGPT.app/Contents/Resources/codex',
      codexExecutableSha256: 'a'.repeat(64),
      runtimePaths: {
        codexHome: TARGET_HOME,
        fakeHome: '/private/tmp/orca-lab/runtime/dispatches/dispatch-757-host-port/fake-home'
      }
    }
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
  it('resolves only the fixed helper beside the running macOS executable', () => {
    const pathExists = vi.fn(() => true)

    expect(
      resolveCodexLabKeychainWriterPath('/Applications/Orca.app/Contents/MacOS/Orca', pathExists)
    ).toBe(KEYCHAIN_WRITER)
    expect(pathExists).toHaveBeenCalledExactlyOnceWith(KEYCHAIN_WRITER)
    expect(
      resolveCodexLabKeychainWriterPath('/Applications/Orca.app/Contents/MacOS/Orca', () => false)
    ).toBeNull()
  })

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
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(source('file', MANAGED_HOME)), {
      platform: 'darwin',
      readCredentialFile,
      observeTargetAuthJson: async () => 'absent'
    })

    await expect(ports.source.readCredential()).resolves.toBe(JSON.stringify(JSON.parse(secret)))
    expect(readCredentialFile).toHaveBeenCalledExactlyOnceWith(`${MANAGED_HOME}/auth.json`)
  })

  it('fails closed for an unproven keyring-backed source without starting a process', async () => {
    const executeKeychainWriter = vi.fn()
    const readCredentialFile = vi.fn()
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(source('keyring')), {
      platform: 'darwin',
      executeKeychainWriter,
      readCredentialFile,
      observeTargetAuthJson: async () => 'absent'
    })

    await expect(ports.source.readCredential()).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: {
        operation: 'source_read',
        reason: 'source_keyring_unproven'
      }
    })
    expect(readCredentialFile).not.toHaveBeenCalled()
    expect(executeKeychainWriter).not.toHaveBeenCalled()
  })

  it('refuses install before helper execution while sealed device/inode are absent', async () => {
    const secret = credential('must-not-leave-process')
    const calls: CodexLabKeychainWriterRequest[] = []
    const executeKeychainWriter = vi.fn(async (command: CodexLabKeychainWriterRequest) => {
      calls.push(command)
      throw new Error('unreachable')
    })
    const observeTargetAuthJson = vi.fn(async () => 'absent' as const)
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(), {
      platform: 'darwin',
      executeKeychainWriter,
      keychainWriterPath: KEYCHAIN_WRITER,
      observeTargetAuthJson
    })

    await expect(
      ports.targetKeyring.replaceAndVerifyCredential({ ...targetLocator(), secret })
    ).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: {
        operation: 'target_write',
        reason: 'sealed_executable_identity_missing'
      }
    })
    expect(calls).toEqual([])
    expect(observeTargetAuthJson).toHaveBeenCalledExactlyOnceWith(TARGET_AUTH_JSON)
  })

  it('refuses delete before helper execution while sealed device/inode are absent', async () => {
    const executeKeychainWriter = vi.fn()
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(), {
      platform: 'darwin',
      executeKeychainWriter,
      keychainWriterPath: KEYCHAIN_WRITER,
      observeTargetAuthJson: async () => 'absent'
    })

    await expect(ports.targetKeyring.deleteCredential(targetLocator())).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'target_delete', reason: 'sealed_executable_identity_missing' }
    })
    expect(executeKeychainWriter).not.toHaveBeenCalled()
  })

  it('treats non-categorical helper output as a sanitized write failure', async () => {
    const leaked = credential('helper-output-must-not-leak')
    const failure = installKeyringCredentialWithWriter(
      async () => ({
        code: 0,
        timedOut: false,
        outputTruncated: false,
        stdout: leaked,
        stderr: ''
      }),
      KEYCHAIN_WRITER,
      DISPATCH_ID,
      hostArgs().launchPlan.executable,
      credential(),
      (operation, reason) => new CodexLabCredentialHostPortRefusal({ operation, reason })
    )
    await expect(failure).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'target_write', reason: 'keyring_writer_failed' }
    })
    await expect(failure).rejects.not.toThrow(/access-secret|refresh-secret/)
  })

  it('refuses credentials over 2 MiB before starting the helper', async () => {
    const executeKeychainWriter = vi.fn()

    await expect(
      installKeyringCredentialWithWriter(
        executeKeychainWriter,
        KEYCHAIN_WRITER,
        DISPATCH_ID,
        hostArgs().launchPlan.executable,
        'x'.repeat(2 * 1024 * 1024 + 1),
        (operation, reason) => new CodexLabCredentialHostPortRefusal({ operation, reason })
      )
    ).rejects.toMatchObject({
      data: { operation: 'target_write', reason: 'keyring_writer_failed' }
    })
    expect(executeKeychainWriter).not.toHaveBeenCalled()
  })

  it('does not bypass missing executable identity during materialization cleanup', async () => {
    const executeKeychainWriter = vi.fn()
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(), {
      platform: 'darwin',
      executeKeychainWriter,
      keychainWriterPath: KEYCHAIN_WRITER,
      readCredentialFile: async () => credential('unavailable-writer'),
      observeTargetAuthJson: async () => 'absent'
    })

    await expect(materializeCodexLabChatGptCredential(request(), ports)).rejects.toMatchObject({
      data: { reason: 'target_cleanup_failed' }
    })
    expect(executeKeychainWriter).not.toHaveBeenCalled()
  })

  it('encodes future cleanup as an exact helper-only delete with no credential input', async () => {
    const calls: CodexLabKeychainWriterRequest[] = []
    await deleteKeyringCredentialWithWriter(
      async (command) => {
        calls.push(command)
        return {
          code: 0,
          timedOut: false,
          outputTruncated: false,
          stdout: 'deleted\n',
          stderr: ''
        }
      },
      KEYCHAIN_WRITER,
      DISPATCH_ID,
      (operation, reason) => new CodexLabCredentialHostPortRefusal({ operation, reason })
    )

    expect(calls).toEqual([{ program: KEYCHAIN_WRITER, args: ['delete', DISPATCH_ID] }])
    expect(JSON.stringify(calls)).not.toMatch(/access-secret|refresh-secret/)
    expect(calls[0]).not.toHaveProperty('input')
  })

  it('sanitizes command failures even when rejected output contains credentials', async () => {
    const leaked = credential('must-not-leak')
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(source('file')), {
      platform: 'darwin',
      readCredentialFile: async () => {
        throw new Error(`credential file read failed with ${leaked}`)
      },
      observeTargetAuthJson: async () => 'absent'
    })

    const failure = ports.source.readCredential()
    await expect(failure).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'source_read', reason: 'credential_file_read_failed' }
    })
    await expect(failure).rejects.not.toThrow(/access-secret|refresh-secret/)
  })

  // The old `/usr/bin/security` source-Keychain route is intentionally gone: its stdout could not
  // prove a complete, non-truncated secret transfer. Keep the truncation invariant on the sole
  // remaining child-process boundary while the source-keyring test above proves no process starts.
  it('does not accept truncated helper output and never reflects credential output', async () => {
    const leaked = credential('truncated-output')
    const failure = installKeyringCredentialWithWriter(
      async () => ({
        code: 0,
        timedOut: false,
        outputTruncated: true,
        stdout: 'installed\n',
        stderr: leaked
      }),
      KEYCHAIN_WRITER,
      DISPATCH_ID,
      hostArgs().launchPlan.executable,
      credential(),
      (operation, reason) => new CodexLabCredentialHostPortRefusal({ operation, reason })
    )
    await expect(failure).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'target_write', reason: 'keyring_writer_failed' }
    })
    await expect(failure).rejects.not.toThrow(/access-secret|refresh-secret/)
  })

  it('refuses target auth.json residue before write without invoking Keychain', async () => {
    const executeKeychainWriter = vi.fn()
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(), {
      platform: 'darwin',
      executeKeychainWriter,
      keychainWriterPath: KEYCHAIN_WRITER,
      readCredentialFile: async () => credential(),
      observeTargetAuthJson: async () => 'present'
    })

    await expect(
      ports.targetKeyring.replaceAndVerifyCredential({
        ...targetLocator(),
        secret: credential()
      })
    ).rejects.toMatchObject({
      code: CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSAL_CODE,
      data: { operation: 'target_write', reason: 'target_auth_json_present' }
    })
    expect(executeKeychainWriter).not.toHaveBeenCalled()
  })

  it('still deletes Keychain residue before reporting target auth.json found during cleanup', async () => {
    const calls: CodexLabSecurityCommandRequest[] = []
    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(), {
      platform: 'darwin',
      executeSecurityCommand: async (command) => {
        calls.push(command)
        return processResult()
      },
      observeTargetAuthJson: async () => 'present'
    })

    await expect(ports.targetKeyring.deleteCredential(targetLocator())).rejects.toMatchObject({
      data: { operation: 'target_delete', reason: 'target_auth_json_present' }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].args[0]).toBe('delete-generic-password')
  })

  it('rejects a broadened locator and unsupported hosts without touching either store', async () => {
    const executeSecurityCommand = vi.fn(async () => processResult())
    expect(() =>
      createCodexLabChatGptCredentialHostPorts(hostArgs(), {
        platform: 'linux',
        executeSecurityCommand
      })
    ).toThrow(
      expect.objectContaining({
        data: { operation: 'source_selection', reason: 'platform_unsupported' }
      })
    )

    const ports = createCodexLabChatGptCredentialHostPorts(hostArgs(), {
      platform: 'darwin',
      executeSecurityCommand,
      executeKeychainWriter: async () => writerResult(),
      keychainWriterPath: KEYCHAIN_WRITER,
      observeTargetAuthJson: async () => 'absent'
    })
    await expect(
      ports.targetKeyring.replaceAndVerifyCredential({
        service: 'Codex Auth',
        account: 'cli|wrong',
        secret: credential()
      })
    ).rejects.toMatchObject({
      data: { operation: 'target_write', reason: 'keyring_locator_mismatch' }
    })
    expect(executeSecurityCommand).not.toHaveBeenCalled()
  })

  it('binds the helper account and home to the validated dispatch id', () => {
    expect(() =>
      createCodexLabChatGptCredentialHostPorts(
        { ...hostArgs(), dispatchId: 'another-dispatch' },
        {
          platform: 'darwin',
          keychainWriterPath: KEYCHAIN_WRITER,
          executeKeychainWriter: async () => writerResult()
        }
      )
    ).toThrow(
      expect.objectContaining({
        data: { operation: 'source_selection', reason: 'target_home_invalid' }
      })
    )
  })
})
