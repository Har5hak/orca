import { describe, expect, it, vi } from 'vitest'
import { CodexLabCredentialHostPortRefusal } from './codex-lab-chatgpt-credential-host-ports'
import { selectSecureHostCodexCredentialSource } from './codex-lab-chatgpt-credential-source-selection'

const SOURCE_HOME = '/Users/operator/.codex'

function settings() {
  return {
    activeCodexManagedAccountId: null,
    activeCodexManagedAccountIdsByRuntime: { host: null, wsl: {} },
    codexManagedAccounts: []
  }
}

describe('Codex laboratory ChatGPT credential source selection', () => {
  it.each([
    { file: 'present' as const, keyring: 'absent' as const, storage: 'file' as const },
    { file: 'absent' as const, keyring: 'present' as const, storage: 'keyring' as const }
  ])('selects the sole securely present $storage store', async ({ file, keyring, storage }) => {
    const observeCredentialFile = vi.fn(async () => file)
    const observeKeyringCredential = vi.fn(async () => keyring)

    await expect(
      selectSecureHostCodexCredentialSource(
        { settings: settings(), systemCodexHomePath: SOURCE_HOME },
        { platform: 'darwin', observeCredentialFile, observeKeyringCredential }
      )
    ).resolves.toEqual({
      canonicalCodexHome: SOURCE_HOME,
      selectedAccountId: null,
      storage
    })
    expect(observeCredentialFile).toHaveBeenCalledExactlyOnceWith(`${SOURCE_HOME}/auth.json`)
    expect(observeKeyringCredential).toHaveBeenCalledExactlyOnceWith({
      service: 'Codex Auth',
      account: 'cli|015e728347e91c37'
    })
  })

  it.each([
    { file: 'present' as const, keyring: 'present' as const, reason: 'source_ambiguous' },
    { file: 'absent' as const, keyring: 'absent' as const, reason: 'source_unavailable' }
  ])('refuses $reason instead of guessing a store', async ({ file, keyring, reason }) => {
    await expect(
      selectSecureHostCodexCredentialSource(
        { settings: settings(), systemCodexHomePath: SOURCE_HOME },
        {
          platform: 'darwin',
          observeCredentialFile: async () => file,
          observeKeyringCredential: async () => keyring
        }
      )
    ).rejects.toMatchObject({
      data: { operation: 'source_selection', reason }
    })
  })

  it('does not fall back to Keychain when auth.json is present but insecure', async () => {
    const insecureFile = new CodexLabCredentialHostPortRefusal({
      operation: 'source_read',
      reason: 'credential_file_invalid'
    })

    await expect(
      selectSecureHostCodexCredentialSource(
        { settings: settings(), systemCodexHomePath: SOURCE_HOME },
        {
          platform: 'darwin',
          observeCredentialFile: async () => {
            throw insecureFile
          },
          observeKeyringCredential: async () => 'present'
        }
      )
    ).rejects.toBe(insecureFile)
  })

  it('probes only exact Keychain metadata without requesting the credential value', async () => {
    const executeSecurityCommand = vi.fn(async () => ({
      code: 0,
      timedOut: false,
      outputTruncated: false,
      stdout: 'metadata only',
      stderr: ''
    }))

    await expect(
      selectSecureHostCodexCredentialSource(
        { settings: settings(), systemCodexHomePath: SOURCE_HOME },
        {
          platform: 'darwin',
          executeSecurityCommand,
          observeCredentialFile: async () => 'absent'
        }
      )
    ).resolves.toMatchObject({ storage: 'keyring' })
    expect(executeSecurityCommand).toHaveBeenCalledExactlyOnceWith({
      program: '/usr/bin/security',
      args: ['find-generic-password', '-s', 'Codex Auth', '-a', 'cli|015e728347e91c37']
    })
  })
})
