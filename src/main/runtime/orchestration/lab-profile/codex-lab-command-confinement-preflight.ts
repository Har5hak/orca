import { isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ProcessResult, ProcessSpec } from '../../../../shared/child-process/run-process'
import { CODEX_LAB_PERMISSION_PROFILE_ID } from './codex-lab-launch-policy'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
  CODEX_LAB_COMMAND_CONFINEMENT_REMAINING_GATES,
  CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION,
  CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
  CodexLabCommandConfinementRefusal,
  type CodexLabCommandConfinementCandidate,
  type CodexLabCommandConfinementControlEvidence,
  type CodexLabCommandConfinementExecutor,
  type CodexLabCommandConfinementPreflightInput,
  type CodexLabCommandConfinementProbeReport,
  type CodexLabProbeIdentityCandidate
} from './codex-lab-command-confinement-contract'
import {
  invalidCodexLabProbeReportJson,
  readCodexLabCommandConfinementInputEnvelope,
  snapshotAndValidateCodexLabPreparedLayout,
  snapshotAndValidateCodexLabProbeCandidate,
  snapshotCodexLabCommandConfinementControls,
  validateCodexLabCommandConfinementControls
} from './codex-lab-command-confinement-evidence'
import type { PreparedCodexLabRuntimeLayout } from './codex-lab-runtime-layout'

const RUN_NONCE_PATTERN = /^[a-f0-9]{32}$/
const LOOPBACK_HOST = '127.0.0.1' as const
const PRIVATE_TMP_ROOT = '/private/tmp' as const

type ConfinementTargets = Readonly<{
  worktreeWrite: string
  codexHomeWrite: string
  fakeHomeWrite: string
  privateTmpWrite: string
  outsideRootWrite: string
  unixBind: string
}>

export async function runCodexLabCommandConfinementPreflight(
  input: CodexLabCommandConfinementPreflightInput,
  execute: CodexLabCommandConfinementExecutor
): Promise<CodexLabCommandConfinementCandidate> {
  const envelope = readCodexLabCommandConfinementInputEnvelope(input)
  const plan = envelope.plan
  assertPlan(plan)
  const prepared = snapshotAndValidateCodexLabPreparedLayout(plan, envelope.preparedLayout)
  const probe = snapshotAndValidateCodexLabProbeCandidate(envelope.probeIdentityCandidate)
  const controls = snapshotCodexLabCommandConfinementControls(envelope.controls)
  const runNonce = envelope.runNonce
  if (!RUN_NONCE_PATTERN.test(runNonce)) {
    throw new CodexLabCommandConfinementRefusal('target_invalid', 'runNonce')
  }
  if (isAtOrInside(PRIVATE_TMP_ROOT, controls.writes.outsideRoot.parent.path)) {
    throw new CodexLabCommandConfinementRefusal('target_invalid', 'controls.writes.outsideRoot')
  }
  const targets = buildTargets(
    plan.dispatchId,
    runNonce,
    plan.cwd,
    plan.runtimePaths,
    controls.writes.outsideRoot.parent.path
  )
  validateCodexLabCommandConfinementControls({ plan, prepared, runNonce, controls, targets })
  const expected = buildExpectedReport(plan, prepared, probe, controls, targets)
  const spec = buildProcessSpec(plan, prepared, probe.path, controls, targets, runNonce)

  let result: ProcessResult
  try {
    result = await execute(spec)
  } catch {
    throw new CodexLabCommandConfinementRefusal('execution_failed')
  }
  assertSuccessfulBoundedResult(result)
  const probeReport = parseCodexLabCommandConfinementProbeReport(result.stdout, expected)
  return deepFreezeCodexLabConfinementValue({
    state: 'candidate-unverified',
    readiness: 'blocked',
    controlTrust: 'caller-asserted-untrusted',
    controls,
    probeReport,
    remainingGates: CODEX_LAB_COMMAND_CONFINEMENT_REMAINING_GATES
  })
}

function assertPlan(plan: CodexLabCommandConfinementPreflightInput['plan']): void {
  try {
    if (
      !Object.isFrozen(plan) ||
      !Object.isFrozen(plan.argv) ||
      !Object.isFrozen(plan.environment) ||
      !Object.isFrozen(plan.environment.injected) ||
      !Object.isFrozen(plan.runtimePaths)
    ) {
      throw new Error('mutable plan')
    }
    assertSealedCodexLabLaunchPlan(plan)
  } catch {
    throw new CodexLabCommandConfinementRefusal('plan_invalid')
  }
}

function buildTargets(
  dispatchId: string,
  runNonce: string,
  worktreePath: string,
  runtimePaths: Readonly<{ codexHome: string; fakeHome: string }>,
  outsideRootParent: string
): ConfinementTargets {
  const basename = `.orca-command-confinement-${dispatchId}-${runNonce}`
  return deepFreezeCodexLabConfinementValue({
    worktreeWrite: join(worktreePath, `${basename}.write`),
    codexHomeWrite: join(runtimePaths.codexHome, `${basename}.write`),
    fakeHomeWrite: join(runtimePaths.fakeHome, `${basename}.write`),
    privateTmpWrite: join(PRIVATE_TMP_ROOT, `${basename}.write`),
    outsideRootWrite: join(outsideRootParent, `${basename}.write`),
    unixBind: join(PRIVATE_TMP_ROOT, `${basename}.sock`)
  })
}

function buildProcessSpec(
  plan: CodexLabCommandConfinementPreflightInput['plan'],
  prepared: PreparedCodexLabRuntimeLayout,
  probePath: string,
  controls: CodexLabCommandConfinementControlEvidence,
  targets: ConfinementTargets,
  runNonce: string
): ProcessSpec {
  const options = (...pairs: readonly (readonly [string, string])[]): string[] => pairs.flat()
  return Object.freeze({
    program: plan.executable,
    args: Object.freeze([
      'sandbox',
      '--include-managed-config',
      '-P',
      CODEX_LAB_PERMISSION_PROFILE_ID,
      '-C',
      plan.cwd,
      '--',
      probePath,
      ...options(
        ['--schema-version', String(CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION)],
        ['--run-nonce', runNonce],
        ['--worktree-identity', plan.worktreeIdentity],
        ['--worktree-path', plan.cwd],
        ['--worktree-read-target', controls.worktreeRead.target],
        ['--worktree-read-sha256', controls.worktreeRead.sha256],
        ['--worktree-write-target', targets.worktreeWrite],
        ['--write-payload', runNonce],
        ['--dispatch-root', prepared.dispatchRoot],
        ['--config-path', prepared.configPath],
        ['--config-sha256', prepared.configSha256],
        ['--codex-home', plan.runtimePaths.codexHome],
        ['--codex-home-write-target', targets.codexHomeWrite],
        ['--fake-home', plan.runtimePaths.fakeHome],
        ['--fake-home-write-target', targets.fakeHomeWrite],
        ['--private-tmp-write-target', targets.privateTmpWrite],
        ['--outside-root-write-target', targets.outsideRootWrite],
        ['--tcp-connect-host', LOOPBACK_HOST],
        ['--tcp-connect-port', String(controls.network.tcpConnect.port)],
        ['--tcp-connect-challenge', controls.network.tcpConnect.challengeToken],
        ['--tcp-bind-host', LOOPBACK_HOST],
        ['--tcp-bind-port', '0'],
        ['--unix-connect-path', plan.gatewaySocketPath],
        ['--unix-connect-challenge', controls.network.unixConnect.challengeToken],
        ['--unix-bind-path', targets.unixBind]
      )
    ]),
    cwd: plan.cwd,
    env: Object.freeze({
      CODEX_HOME: plan.runtimePaths.codexHome,
      HOME: plan.runtimePaths.fakeHome
    }),
    timeoutMs: CODEX_LAB_COMMAND_CONFINEMENT_TIMEOUT_MS,
    maxOutputBytes: CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
    terminationBarrier: true
  })
}

function buildExpectedReport(
  plan: CodexLabCommandConfinementPreflightInput['plan'],
  prepared: PreparedCodexLabRuntimeLayout,
  probe: CodexLabProbeIdentityCandidate,
  controls: CodexLabCommandConfinementControlEvidence,
  targets: ConfinementTargets
): CodexLabCommandConfinementProbeReport {
  const deniedWrite = (root: string, target: string) =>
    Object.freeze({
      root,
      target,
      syscall: 'open(O_CREAT|O_EXCL|O_WRONLY)' as const,
      result: 'denied-by-sandbox' as const,
      errno: 'EPERM' as const
    })
  return deepFreezeCodexLabConfinementValue({
    schemaVersion: CODEX_LAB_COMMAND_CONFINEMENT_SCHEMA_VERSION,
    probe: Object.freeze({
      path: probe.path,
      sha256: probe.observedSha256,
      device: probe.device,
      inode: probe.inode,
      identityTrust: 'candidate-only' as const
    }),
    layout: Object.freeze({
      dispatchId: prepared.dispatchId,
      dispatchRoot: prepared.dispatchRoot,
      dispatchRootIdentity: prepared.dispatchRootIdentity,
      codexHomeIdentity: prepared.codexHomeIdentity,
      fakeHomeIdentity: prepared.fakeHomeIdentity,
      configIdentity: prepared.configIdentity,
      configSha256: prepared.configSha256
    }),
    worktree: Object.freeze({
      identity: plan.worktreeIdentity,
      path: plan.cwd,
      read: Object.freeze({
        target: controls.worktreeRead.target,
        sha256: controls.worktreeRead.sha256,
        syscall: 'open(O_RDONLY)' as const,
        result: 'succeeded' as const
      }),
      write: deniedWrite(plan.cwd, targets.worktreeWrite)
    }),
    writes: Object.freeze({
      codexHome: deniedWrite(plan.runtimePaths.codexHome, targets.codexHomeWrite),
      fakeHome: deniedWrite(plan.runtimePaths.fakeHome, targets.fakeHomeWrite),
      privateTmp: deniedWrite(PRIVATE_TMP_ROOT, targets.privateTmpWrite),
      outsideRoot: deniedWrite(controls.writes.outsideRoot.parent.path, targets.outsideRootWrite)
    }),
    network: Object.freeze({
      tcpConnect: Object.freeze({
        host: LOOPBACK_HOST,
        port: controls.network.tcpConnect.port,
        challengeSha256: controls.network.tcpConnect.challengeSha256,
        syscall: 'connect(AF_INET,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      }),
      tcpBind: Object.freeze({
        host: LOOPBACK_HOST,
        port: 0 as const,
        syscall: 'bind(AF_INET,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      }),
      unixConnect: Object.freeze({
        path: plan.gatewaySocketPath,
        challengeSha256: controls.network.unixConnect.challengeSha256,
        syscall: 'connect(AF_UNIX,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      }),
      unixBind: Object.freeze({
        path: targets.unixBind,
        syscall: 'bind(AF_UNIX,SOCK_STREAM)' as const,
        result: 'denied-by-sandbox' as const,
        errno: 'EPERM' as const
      })
    })
  })
}

function assertSuccessfulBoundedResult(result: ProcessResult): void {
  if (result.timedOut !== false) {
    throw new CodexLabCommandConfinementRefusal('process_timed_out')
  }
  if (
    result.outputTruncated === true ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout, 'utf8') > CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES
  ) {
    throw new CodexLabCommandConfinementRefusal('output_truncated')
  }
  if (result.code !== 0 || result.signal !== null || result.stderr !== '') {
    throw new CodexLabCommandConfinementRefusal('process_failed')
  }
}

function parseCodexLabCommandConfinementProbeReport(
  stdout: string,
  expected: CodexLabCommandConfinementProbeReport
): CodexLabCommandConfinementProbeReport {
  if (invalidCodexLabProbeReportJson(stdout)) {
    throw new CodexLabCommandConfinementRefusal('probe_report_malformed', 'stdout')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new CodexLabCommandConfinementRefusal('probe_report_malformed', 'stdout')
  }
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new CodexLabCommandConfinementRefusal('probe_report_mismatch', 'stdout')
  }
  return expected
}

function deepFreezeCodexLabConfinementValue<T extends object>(value: T): Readonly<T> {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') {
      deepFreezeCodexLabConfinementValue(nested)
    }
  }
  return Object.freeze(value)
}

function isAtOrInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}
