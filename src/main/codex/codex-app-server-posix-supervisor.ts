import type { CodexAppServerLaunch } from './codex-app-server-connection'

/** Inline supervisor source kept dependency-free for the spawned Node child. */
export const POSIX_PROVIDER_SUPERVISOR_SCRIPT = `
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} = require('node:fs')
const { isAbsolute } = require('node:path')
const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
const childEnv = { ...process.env }
delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC
delete childEnv.ELECTRON_RUN_AS_NODE
const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
const sameSnapshot = (left, right) =>
  sameIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs
const openVerifiedExecutable = () => {
  const expected = spec.executableIntegrity
  if (!expected) return null
  if (
    typeof expected.canonicalPath !== 'string' ||
    expected.canonicalPath !== spec.command ||
    !isAbsolute(expected.canonicalPath) ||
    typeof expected.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    typeof constants.O_NOFOLLOW !== 'number'
  ) {
    throw new Error('invalid executable integrity authority')
  }
  const named = lstatSync(spec.command, { bigint: true })
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    (named.mode & 0o111n) === 0n ||
    realpathSync.native(spec.command) !== spec.command
  ) {
    throw new Error('executable integrity path is not a canonical executable file')
  }
  const descriptor = openSync(spec.command, constants.O_RDONLY | constants.O_NOFOLLOW)
  let verified = false
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || !sameIdentity(before, named)) {
      throw new Error('executable identity changed before verification')
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytesRead
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, bytesRead))
    }
    const after = fstatSync(descriptor, { bigint: true })
    const namedAfter = lstatSync(spec.command, { bigint: true })
    if (
      !sameSnapshot(before, after) ||
      !sameSnapshot(after, namedAfter) ||
      namedAfter.isSymbolicLink() ||
      realpathSync.native(spec.command) !== spec.command ||
      digest.digest('hex') !== expected.sha256
    ) {
      throw new Error('executable identity or digest changed before spawn')
    }
    verified = true
    return descriptor
  } finally {
    if (!verified) closeSync(descriptor)
  }
}
let verifiedExecutableDescriptor
try {
  verifiedExecutableDescriptor = openVerifiedExecutable()
} catch {
  process.stderr.write('Orca refused provider executable integrity before spawn.\\n')
  process.exit(126)
}
let child
try {
  child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  })
} finally {
  if (verifiedExecutableDescriptor !== null) closeSync(verifiedExecutableDescriptor)
}
const originalParent = process.ppid
let timer
let ownerShutdownTimer
let settling = false
const providerGroupExists = () => {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code !== 'ESRCH')
  }
}
const reapOwnedProviderGroup = async () => {
  if (!child.pid) return false
  try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
    if (error && error.code !== 'ESRCH') return false
  }
  const deadline = Date.now() + 1500
  while (providerGroupExists()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}
const terminateOwnedGroup = () => {
  if (settling) return
  settling = true
  clearInterval(timer)
  void reapOwnedProviderGroup().then((reaped) => process.exit(reaped ? 137 : 1))
}
const scheduleOwnerShutdown = () => {
  if (settling || ownerShutdownTimer) return
  // A normal close ends the provider's stdin first; allow it to flush and
  // exit before forcing the group, while still bounding an orphaned child.
  ownerShutdownTimer = setTimeout(terminateOwnedGroup, 1250)
  ownerShutdownTimer.unref()
}
process.stdin.once('end', scheduleOwnerShutdown)
process.stdin.once('close', scheduleOwnerShutdown)
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const stream of [process.stdin, child.stdin, child.stdout, child.stderr]) stream.on('error', () => {})
const finishWithProviderOutcome = (code, signal) => {
  if (!signal) return process.exit(code ?? 1)
  process.kill(process.pid, signal)
}
const reapProviderExit = async (code, signal) => {
  if (settling) return
  settling = true
  clearInterval(timer)
  if (ownerShutdownTimer) clearTimeout(ownerShutdownTimer)
  if (!(await reapOwnedProviderGroup())) return process.exit(1)
  finishWithProviderOutcome(code, signal)
}
timer = setInterval(() => {
  // A detached supervisor is reparented when its owner exits. The new parent
  // may be PID 1 or a platform subreaper, so any parent change is proof that
  // this process group no longer has a live Orca owner.
  if (process.ppid !== originalParent) {
    terminateOwnedGroup()
  }
}, 100)
timer.unref()
child.once('error', () => {
  clearInterval(timer)
  process.exit(127)
})
child.once('exit', (code, signal) => {
  void reapProviderExit(code, signal)
})
`

export function supervisedPosixLaunch(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  cwd = launch.cwd ?? process.cwd()
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const supervisorSpec = Buffer.from(
    JSON.stringify({
      command: launch.command,
      args: launch.args,
      cwd,
      ...(launch.executableIntegrity ? { executableIntegrity: launch.executableIntegrity } : {})
    })
  ).toString('base64')
  return {
    command: process.execPath,
    args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT],
    // Electron's executable needs Node mode for the inline supervisor. The
    // marker is removed above so providers never inherit Electron semantics.
    env: {
      ...childEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ORCA_PROVIDER_SUPERVISOR_SPEC: supervisorSpec
    }
  }
}

export function createProviderSpawnSpec(
  launch: CodexAppServerLaunch,
  childEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { program: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; detached: boolean } {
  if (platform === 'win32' && launch.executableIntegrity) {
    throw new Error('Codex executable integrity cannot be enforced on a direct-spawn platform')
  }
  const supervised = platform === 'win32' ? null : supervisedPosixLaunch(launch, childEnv)
  return {
    program: supervised?.command ?? launch.command,
    args: supervised?.args ?? launch.args,
    env: supervised?.env ?? childEnv,
    cwd: launch.cwd ?? process.cwd(),
    detached: platform !== 'win32'
  }
}
