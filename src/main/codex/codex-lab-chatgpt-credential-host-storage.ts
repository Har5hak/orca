import { constants, type Stats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { runProcess } from '../../shared/child-process/run-process'
import type { CodexAuthKeyringLocator } from './codex-lab-chatgpt-credential-materialization'

const SECURITY_PROGRAM = '/usr/bin/security' as const
const SECURITY_TIMEOUT_MS = 3_000
const SECURITY_MAX_OUTPUT_BYTES = 64 * 1024
const MAX_CREDENTIAL_BYTES = 2 * 1024 * 1024
const KEYRING_NOT_FOUND_EXIT_CODE = 44
const PRIVATE_CREDENTIAL_FILE_MODE = 0o600

export type CodexLabSecurityCommandRequest = Readonly<{
  program: typeof SECURITY_PROGRAM
  args: readonly string[]
}>

export type CodexLabSecurityCommandResult = Readonly<{
  code: number | null
  timedOut: boolean
  outputTruncated?: boolean
  stdout: string
  stderr: string
}>

export type CodexLabSecurityCommandExecutor = (
  request: CodexLabSecurityCommandRequest
) => Promise<CodexLabSecurityCommandResult>

export type TargetAuthJsonObservation = 'absent' | 'indeterminate' | 'present'
export type CodexLabCredentialSourceObservation = 'absent' | 'present'

type StorageOperation = 'source_read' | 'target_delete' | 'target_read' | 'target_write'
type StorageRefusalReason =
  | 'credential_file_invalid'
  | 'credential_file_read_failed'
  | 'keyring_command_failed'
type Refuse = (operation: StorageOperation, reason: StorageRefusalReason) => Error

export async function executeSecurityCommand(
  request: CodexLabSecurityCommandRequest
): Promise<CodexLabSecurityCommandResult> {
  return runProcess({
    program: request.program,
    args: request.args,
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    timeoutMs: SECURITY_TIMEOUT_MS,
    maxOutputBytes: SECURITY_MAX_OUTPUT_BYTES
  })
}

export async function readKeyringCredential(
  execute: CodexLabSecurityCommandExecutor,
  locator: CodexAuthKeyringLocator,
  operation: 'source_read' | 'target_read',
  refuse: Refuse
): Promise<string | null> {
  const result = await runSecurityCommand(
    execute,
    operation,
    ['find-generic-password', '-s', locator.service, '-a', locator.account, '-w'],
    refuse
  )
  if (result.code === KEYRING_NOT_FOUND_EXIT_CODE && !result.timedOut && !result.outputTruncated) {
    return null
  }
  assertSecuritySuccess(result, operation, refuse)
  return stripCommandLineEnding(result.stdout)
}

export async function observeKeyringCredential(
  execute: CodexLabSecurityCommandExecutor,
  locator: CodexAuthKeyringLocator,
  refuse: Refuse
): Promise<CodexLabCredentialSourceObservation> {
  const result = await runSecurityCommand(
    execute,
    'source_read',
    ['find-generic-password', '-s', locator.service, '-a', locator.account],
    refuse
  )
  if (result.code === KEYRING_NOT_FOUND_EXIT_CODE && !result.timedOut && !result.outputTruncated) {
    return 'absent'
  }
  assertSecuritySuccess(result, 'source_read', refuse)
  return 'present'
}

export async function deleteKeyringCredential(
  execute: CodexLabSecurityCommandExecutor,
  locator: CodexAuthKeyringLocator,
  refuse: Refuse
): Promise<void> {
  const result = await runSecurityCommand(
    execute,
    'target_delete',
    ['delete-generic-password', '-s', locator.service, '-a', locator.account],
    refuse
  )
  if (result.code !== KEYRING_NOT_FOUND_EXIT_CODE || result.timedOut || result.outputTruncated) {
    assertSecuritySuccess(result, 'target_delete', refuse)
  }
}

export async function observeTargetAuthJsonPath(
  filePath: string
): Promise<TargetAuthJsonObservation> {
  try {
    await lstat(filePath)
    return 'present'
  } catch (error) {
    return isDefinitiveAbsence(error) ? 'absent' : 'indeterminate'
  }
}

export async function readCredentialFileSecurely(
  filePath: string,
  refuse: Refuse,
  expectedUid = requireProcessUid(refuse)
): Promise<string | null> {
  const handle = await openCredentialFileSecurely(filePath, refuse)
  if (!handle) {
    return null
  }
  try {
    const stat = await handle.stat()
    assertSecureCredentialFile(stat, expectedUid, refuse)
    const contents = await handle.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(contents, 'utf8') > MAX_CREDENTIAL_BYTES) {
      throw refuse('source_read', 'credential_file_invalid')
    }
    return contents
  } catch (error) {
    if (isStorageRefusal(error)) {
      throw error
    }
    throw refuse('source_read', 'credential_file_read_failed')
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function observeCredentialFileSecurely(
  filePath: string,
  refuse: Refuse,
  expectedUid = requireProcessUid(refuse)
): Promise<CodexLabCredentialSourceObservation> {
  const handle = await openCredentialFileSecurely(filePath, refuse)
  if (!handle) {
    return 'absent'
  }
  try {
    assertSecureCredentialFile(await handle.stat(), expectedUid, refuse)
    return 'present'
  } catch (error) {
    if (isStorageRefusal(error)) {
      throw error
    }
    throw refuse('source_read', 'credential_file_read_failed')
  } finally {
    await handle.close().catch(() => {})
  }
}

async function runSecurityCommand(
  execute: CodexLabSecurityCommandExecutor,
  operation: StorageOperation,
  args: readonly string[],
  refuse: Refuse
): Promise<CodexLabSecurityCommandResult> {
  try {
    return await execute({ program: SECURITY_PROGRAM, args })
  } catch {
    throw refuse(operation, 'keyring_command_failed')
  }
}

function assertSecuritySuccess(
  result: CodexLabSecurityCommandResult,
  operation: StorageOperation,
  refuse: Refuse
): void {
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw refuse(operation, 'keyring_command_failed')
  }
}

function stripCommandLineEnding(value: string): string {
  if (value.endsWith('\r\n')) {
    return value.slice(0, -2)
  }
  return value.endsWith('\n') ? value.slice(0, -1) : value
}

async function openCredentialFileSecurely(
  filePath: string,
  refuse: Refuse
): Promise<FileHandle | null> {
  try {
    return await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    if (isErrnoCode(error, 'ELOOP')) {
      throw refuse('source_read', 'credential_file_invalid')
    }
    throw refuse('source_read', 'credential_file_read_failed')
  }
}

function assertSecureCredentialFile(stat: Stats, expectedUid: number, refuse: Refuse): void {
  if (
    !stat.isFile() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o777) !== PRIVATE_CREDENTIAL_FILE_MODE ||
    stat.size <= 0 ||
    stat.size > MAX_CREDENTIAL_BYTES
  ) {
    throw refuse('source_read', 'credential_file_invalid')
  }
}

function requireProcessUid(refuse: Refuse): number {
  const uid = process.getuid?.()
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw refuse('source_read', 'credential_file_read_failed')
  }
  return uid
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function isStorageRefusal(error: unknown): error is Error {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ORCA_CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSED'
  )
}
