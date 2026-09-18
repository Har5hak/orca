import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { ProcessResult } from '../../../../shared/child-process/run-process'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'
import {
  CODEX_LAB_COMMAND_CONFINEMENT_MAX_OUTPUT_BYTES,
  CODEX_LAB_COMMAND_CONFINEMENT_REMAINING_GATES,
  CodexLabCommandConfinementRefusal,
  type CodexLabCommandConfinementCandidate,
  type CodexLabCommandConfinementExecutor,
  type CodexLabCommandConfinementPreflightInput,
  type CodexLabCommandConfinementProbeReport
} from './codex-lab-command-confinement-contract'
import {
  buildCodexLabCommandConfinementProcessSpec,
  buildExpectedCodexLabCommandConfinementReport
} from './codex-lab-command-confinement-execution'
import {
  invalidCodexLabProbeReportJson,
  readCodexLabCommandConfinementInputEnvelope,
  snapshotAndValidateCodexLabPreparedLayout,
  snapshotAndValidateCodexLabProbeCandidate,
  snapshotCodexLabCommandConfinementControls,
  validateCodexLabCommandConfinementControls
} from './codex-lab-command-confinement-evidence'

const RUN_NONCE_PATTERN = /^[a-f0-9]{32}$/
const PRIVATE_TMP_ROOT = '/private/tmp' as const

export type CodexLabCommandConfinementTargets = Readonly<{
  worktreeWrite: string
  codexHomeWrite: string
  fakeHomeWrite: string
  privateTmpWrite: string
  outsideRootWrite: string
  unixConnectDenied: string
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
  const targets = buildCodexLabCommandConfinementTargets(
    plan.dispatchId,
    runNonce,
    plan.cwd,
    plan.runtimePaths,
    controls.writes.outsideRoot.parent.path
  )
  validateCodexLabCommandConfinementControls({ plan, prepared, runNonce, controls, targets })
  const expected = buildExpectedCodexLabCommandConfinementReport(
    plan,
    prepared,
    probe,
    controls,
    targets
  )
  const spec = buildCodexLabCommandConfinementProcessSpec(
    plan,
    prepared,
    probe,
    controls,
    targets,
    runNonce
  )

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

export function buildCodexLabCommandConfinementTargets(
  dispatchId: string,
  runNonce: string,
  worktreePath: string,
  runtimePaths: Readonly<{ codexHome: string; fakeHome: string }>,
  outsideRootParent: string
): CodexLabCommandConfinementTargets {
  const basename = `.orca-command-confinement-${dispatchId}-${runNonce}`
  const unixSocketBasename = `.orca-cc-${createHash('sha256')
    .update(`${dispatchId}:${runNonce}`)
    .digest('hex')
    .slice(0, 32)}.sock`
  const deniedUnixSocketBasename = `.orca-cc-deny-${createHash('sha256')
    .update(`denied:${dispatchId}:${runNonce}`)
    .digest('hex')
    .slice(0, 32)}.sock`
  return deepFreezeCodexLabConfinementValue({
    worktreeWrite: join(worktreePath, `${basename}.write`),
    codexHomeWrite: join(runtimePaths.codexHome, `${basename}.write`),
    fakeHomeWrite: join(runtimePaths.fakeHome, `${basename}.write`),
    privateTmpWrite: join(PRIVATE_TMP_ROOT, `${basename}.write`),
    outsideRootWrite: join(outsideRootParent, `${basename}.write`),
    unixConnectDenied: join(PRIVATE_TMP_ROOT, deniedUnixSocketBasename),
    unixBind: join(PRIVATE_TMP_ROOT, unixSocketBasename)
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
