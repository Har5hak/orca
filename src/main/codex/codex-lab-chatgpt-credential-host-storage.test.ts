import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexLabCredentialHostPortRefusal } from './codex-lab-chatgpt-credential-host-ports'
import {
  observeCredentialFileSecurely,
  observeKeyringCredential,
  readCredentialFileSecurely
} from './codex-lab-chatgpt-credential-host-storage'

const fsMocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  open: fsMocks.open
}))

const FILE_PATH = '/Users/operator/.codex/auth.json'
const EXPECTED_UID = 501

function refusal(
  operation: 'source_read' | 'target_delete' | 'target_read' | 'target_write',
  reason: 'credential_file_invalid' | 'credential_file_read_failed' | 'keyring_command_failed'
) {
  return new CodexLabCredentialHostPortRefusal({ operation, reason })
}

function handle(
  overrides: Readonly<{
    isFile?: boolean
    mode?: number
    uid?: number
    size?: number
    contents?: string
  }> = {}
) {
  const contents = overrides.contents ?? '{"auth_mode":"chatgpt"}'
  return {
    stat: vi.fn(async () => ({
      isFile: () => overrides.isFile ?? true,
      mode: overrides.mode ?? 0o100600,
      uid: overrides.uid ?? EXPECTED_UID,
      size: overrides.size ?? Buffer.byteLength(contents)
    })),
    readFile: vi.fn(async () => contents),
    close: vi.fn(async () => {})
  }
}

describe('Codex laboratory credential host storage', () => {
  beforeEach(() => {
    fsMocks.open.mockReset()
  })

  it('reads a private regular file owned by the Orca process user', async () => {
    const source = handle()
    fsMocks.open.mockResolvedValue(source)

    await expect(readCredentialFileSecurely(FILE_PATH, refusal, EXPECTED_UID)).resolves.toBe(
      '{"auth_mode":"chatgpt"}'
    )
    expect(source.close).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'group-readable', overrides: { mode: 0o100640 } },
    { name: 'foreign-owned', overrides: { uid: EXPECTED_UID + 1 } },
    { name: 'not-regular', overrides: { isFile: false } },
    { name: 'empty', overrides: { size: 0 } },
    { name: 'oversized', overrides: { size: 2 * 1024 * 1024 + 1 } }
  ])('refuses a $name auth.json before reading it', async ({ overrides }) => {
    const source = handle(overrides)
    fsMocks.open.mockResolvedValue(source)

    await expect(
      readCredentialFileSecurely(FILE_PATH, refusal, EXPECTED_UID)
    ).rejects.toMatchObject({
      data: { operation: 'source_read', reason: 'credential_file_invalid' }
    })
    expect(source.readFile).not.toHaveBeenCalled()
    expect(source.close).toHaveBeenCalledOnce()
  })

  it('refuses a symlink instead of following it', async () => {
    fsMocks.open.mockRejectedValue(Object.assign(new Error('symlink'), { code: 'ELOOP' }))

    await expect(
      readCredentialFileSecurely(FILE_PATH, refusal, EXPECTED_UID)
    ).rejects.toMatchObject({
      data: { operation: 'source_read', reason: 'credential_file_invalid' }
    })
  })

  it('uses the same ownership and mode checks for presence selection', async () => {
    const source = handle({ mode: 0o100644 })
    fsMocks.open.mockResolvedValue(source)

    await expect(
      observeCredentialFileSecurely(FILE_PATH, refusal, EXPECTED_UID)
    ).rejects.toMatchObject({
      data: { operation: 'source_read', reason: 'credential_file_invalid' }
    })
    expect(source.readFile).not.toHaveBeenCalled()
  })

  it('observes exact Keychain metadata without the password-output flag', async () => {
    const execute = vi.fn(async () => ({
      code: 0,
      timedOut: false,
      outputTruncated: false,
      stdout: 'metadata only',
      stderr: ''
    }))

    await expect(
      observeKeyringCredential(
        execute,
        { service: 'Codex Auth', account: 'cli|015e728347e91c37' },
        refusal
      )
    ).resolves.toBe('present')
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      program: '/usr/bin/security',
      args: ['find-generic-password', '-s', 'Codex Auth', '-a', 'cli|015e728347e91c37']
    })
  })

  it('distinguishes exact Keychain absence from command failure', async () => {
    const missing = vi.fn(async () => ({
      code: 44,
      timedOut: false,
      outputTruncated: false,
      stdout: '',
      stderr: ''
    }))
    const failed = vi.fn(async () => ({
      code: 44,
      timedOut: true,
      outputTruncated: false,
      stdout: '',
      stderr: ''
    }))
    const locator = { service: 'Codex Auth' as const, account: 'cli|015e728347e91c37' }

    await expect(observeKeyringCredential(missing, locator, refusal)).resolves.toBe('absent')
    await expect(observeKeyringCredential(failed, locator, refusal)).rejects.toMatchObject({
      data: { operation: 'source_read', reason: 'keyring_command_failed' }
    })
  })
})
