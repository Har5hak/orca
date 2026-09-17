import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { runProcess } from '../../shared/child-process/run-process'
import type { CodexAuthKeyringLocator } from './codex-lab-chatgpt-credential-materialization'

const SECURITY_PROGRAM = '/usr/bin/security' as const
const SECURITY_TIMEOUT_MS = 3_000
const SECURITY_MAX_OUTPUT_BYTES = 64 * 1024
const MAX_CREDENTIAL_BYTES = 2 * 1024 * 1024
const KEYRING_NOT_FOUND_EXIT_CODE = 44

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
  refuse: Refuse
): Promise<string | null> {
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw refuse('source_read', 'credential_file_read_failed')
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_BYTES) {
      throw refuse('source_read', 'credential_file_invalid')
    }
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

function isStorageRefusal(error: unknown): error is Error {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ORCA_CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSED'
  )
}
