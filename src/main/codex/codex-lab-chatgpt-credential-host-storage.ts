import { constants, existsSync } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { runProcess } from '../../shared/child-process/run-process'

const MAX_CREDENTIAL_BYTES = 2 * 1024 * 1024
const KEYCHAIN_WRITER_EXECUTABLE = 'orca-codex-lab-keychain-writer' as const
const KEYCHAIN_WRITER_TIMEOUT_MS = 5_000
const KEYCHAIN_WRITER_MAX_OUTPUT_BYTES = 256
const KEYCHAIN_WRITER_INSTALL_SUCCESS = 'installed\n'
const KEYCHAIN_WRITER_DELETE_SUCCESS = 'deleted\n'

export type CodexLabKeychainWriterInstallRequest = Readonly<{
  program: string
  args: readonly [operation: 'install', dispatchId: string, canonicalCodexExecutable: string]
  input: string
}>

export type CodexLabKeychainWriterDeleteRequest = Readonly<{
  program: string
  args: readonly [operation: 'delete', dispatchId: string]
  input?: never
}>

export type CodexLabKeychainWriterRequest =
  | CodexLabKeychainWriterInstallRequest
  | CodexLabKeychainWriterDeleteRequest

export type CodexLabKeychainWriterResult = Readonly<{
  code: number | null
  timedOut: boolean
  outputTruncated?: boolean
  stdout: string
  stderr: string
}>

export type CodexLabKeychainWriterExecutor = (
  request: CodexLabKeychainWriterRequest
) => Promise<CodexLabKeychainWriterResult>

export type TargetAuthJsonObservation = 'absent' | 'indeterminate' | 'present'

type StorageOperation = 'source_read' | 'target_delete' | 'target_write'
type StorageRefusalReason =
  | 'credential_file_invalid'
  | 'credential_file_read_failed'
  | 'keyring_writer_failed'
type Refuse = (operation: StorageOperation, reason: StorageRefusalReason) => Error

export async function executeCodexLabKeychainWriter(
  request: CodexLabKeychainWriterRequest
): Promise<CodexLabKeychainWriterResult> {
  return runProcess({
    program: request.program,
    args: request.args,
    ...('input' in request ? { input: request.input } : {}),
    env: { LANG: 'C', LC_ALL: 'C' },
    timeoutMs: KEYCHAIN_WRITER_TIMEOUT_MS,
    maxOutputBytes: KEYCHAIN_WRITER_MAX_OUTPUT_BYTES
  })
}

export function resolveCodexLabKeychainWriterPath(
  execPath: string = process.execPath,
  pathExists: (candidatePath: string) => boolean = existsSync
): string | null {
  const candidate = join(dirname(execPath), KEYCHAIN_WRITER_EXECUTABLE)
  return isAbsolute(candidate) && pathExists(candidate) ? candidate : null
}

/**
 * Helper-only install boundary. Production currently refuses before reaching this function because
 * the sealed launch plan does not carry device/inode executable identity.
 */
export async function installKeyringCredentialWithWriter(
  execute: CodexLabKeychainWriterExecutor,
  writerPath: string,
  dispatchId: string,
  canonicalCodexExecutable: string,
  credential: string,
  refuse: Refuse
): Promise<void> {
  if (
    !isAbsolute(writerPath) ||
    !isAbsolute(canonicalCodexExecutable) ||
    Buffer.byteLength(credential, 'utf8') === 0 ||
    Buffer.byteLength(credential, 'utf8') > MAX_CREDENTIAL_BYTES
  ) {
    throw refuse('target_write', 'keyring_writer_failed')
  }
  const result = await runWriter(
    execute,
    {
      program: writerPath,
      args: ['install', dispatchId, canonicalCodexExecutable],
      input: credential
    },
    'target_write',
    refuse
  )
  assertWriterSuccess(result, KEYCHAIN_WRITER_INSTALL_SUCCESS, 'target_write', refuse)
}

/** Delete is never delegated to `/usr/bin/security`; only the fixed native helper may own it. */
export async function deleteKeyringCredentialWithWriter(
  execute: CodexLabKeychainWriterExecutor,
  writerPath: string,
  dispatchId: string,
  refuse: Refuse
): Promise<void> {
  if (!isAbsolute(writerPath)) {
    throw refuse('target_delete', 'keyring_writer_failed')
  }
  const result = await runWriter(
    execute,
    { program: writerPath, args: ['delete', dispatchId] },
    'target_delete',
    refuse
  )
  assertWriterSuccess(result, KEYCHAIN_WRITER_DELETE_SUCCESS, 'target_delete', refuse)
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

async function runWriter(
  execute: CodexLabKeychainWriterExecutor,
  request: CodexLabKeychainWriterRequest,
  operation: 'target_delete' | 'target_write',
  refuse: Refuse
): Promise<CodexLabKeychainWriterResult> {
  try {
    return await execute(request)
  } catch {
    throw refuse(operation, 'keyring_writer_failed')
  }
}

function assertWriterSuccess(
  result: CodexLabKeychainWriterResult,
  expectedStdout: string,
  operation: 'target_delete' | 'target_write',
  refuse: Refuse
): void {
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    result.stdout !== expectedStdout ||
    result.stderr !== ''
  ) {
    throw refuse(operation, 'keyring_writer_failed')
  }
}

function isStorageRefusal(error: unknown): error is Error {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ORCA_CODEX_LAB_CREDENTIAL_HOST_PORT_REFUSED'
  )
}
