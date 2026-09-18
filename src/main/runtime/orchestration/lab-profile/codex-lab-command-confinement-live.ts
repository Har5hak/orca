import { createHash, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { CODEX_LAB_COMMAND_CONFINEMENT_REMAINING_GATES } from './codex-lab-command-confinement-contract'
import {
  buildCodexLabCommandConfinementTargets,
  runCodexLabCommandConfinementPreflight
} from './codex-lab-command-confinement-preflight'
import type {
  CodexLabHostReadinessReceipt,
  CodexLabLiveConfinementHost,
  CodexLabTrustedFileObservation,
  CodexLabTrustedLayoutObservation,
  PrepareVerifiedCodexLabLaunchInput,
  VerifiedCodexLabLaunchPreparation
} from './codex-lab-command-confinement-live-contract'
import {
  CODEX_LAB_LIVE_PROBE_EXECUTABLE,
  CODEX_LAB_LIVE_PROBE_SOURCE_SHA256,
  buildCodexLabLiveProbeCandidate
} from './codex-lab-command-confinement-live-probe'
import { createNativeCodexLabLiveConfinementHost } from './codex-lab-command-confinement-live-native'
import type { SealedCodexLabLaunchPlan } from './codex-lab-launch-contract'
import { assertSealedCodexLabLaunchPlan } from './codex-sealed-launch-plan'

const RUN_NONCE = /^[a-f0-9]{32}$/u
const RECEIPT_SHA = /^[a-f0-9]{64}$/u
const issuedReceipts = new WeakMap<object, CodexLabHostReadinessReceipt>()

export async function prepareVerifiedCodexLabLaunch(
  input: PrepareVerifiedCodexLabLaunchInput,
  host: CodexLabLiveConfinementHost = createNativeCodexLabLiveConfinementHost()
): Promise<VerifiedCodexLabLaunchPreparation> {
  assertSealedCodexLabLaunchPlan(input.plan)
  const initialProbe = host.observeExecutable(CODEX_LAB_LIVE_PROBE_EXECUTABLE)
  const probe = buildCodexLabLiveProbeCandidate(initialProbe)
  const runNonce = host.randomNonce()
  if (!RUN_NONCE.test(runNonce)) {
    throw new Error('trusted confinement host returned an invalid run nonce')
  }
  const trustedProofPaths = deriveTrustedProofPaths(input.plan)
  const targets = buildCodexLabCommandConfinementTargets(
    input.plan.dispatchId,
    runNonce,
    input.plan.cwd,
    input.plan.runtimePaths,
    trustedProofPaths.outsideWriteRoot
  )
  const session = await host.openControlSession({
    ...input,
    ...trustedProofPaths,
    runNonce,
    targets
  })
  let verifiedEvidence:
    | Readonly<{
        controlsSha256: string
        probeReportSha256: string
        exactSpecSha256: string
      }>
    | undefined
  let proofError: unknown
  try {
    let exactSpecSha256 = ''
    const candidate = await runCodexLabCommandConfinementPreflight(
      {
        plan: input.plan,
        preparedLayout: input.preparedLayout,
        probeIdentityCandidate: probe,
        runNonce,
        controls: session.controls
      },
      async (spec) => {
        assertImmediateHostEvidence(input, host, initialProbe)
        exactSpecSha256 = sha256(JSON.stringify(spec))
        const executed = await host.executeExact(spec)
        if (executed.processTreeTermination !== 'verified') {
          throw new Error('confinement process tree termination was not verified')
        }
        return executed.process
      }
    )
    if (!exactSpecSha256) {
      throw new Error('confinement executor did not receive a ProcessSpec')
    }
    session.assertPostExecution(candidate.probeReport)
    assertPreparedLayoutEvidence(input, host)
    if (
      !isDeepStrictEqual(candidate.remainingGates, CODEX_LAB_COMMAND_CONFINEMENT_REMAINING_GATES)
    ) {
      throw new Error('confinement candidate gate inventory changed during trusted promotion')
    }
    verifiedEvidence = Object.freeze({
      controlsSha256: sha256(JSON.stringify(candidate.controls)),
      probeReportSha256: sha256(JSON.stringify(candidate.probeReport)),
      exactSpecSha256
    })
  } catch (error) {
    proofError = error
  }
  let cleanupError: unknown
  try {
    await session.close()
  } catch (error) {
    cleanupError = error
  }
  if (proofError && cleanupError) {
    throw new AggregateError(
      [proofError, cleanupError],
      'confinement proof and trusted control cleanup both failed'
    )
  }
  if (proofError) {
    throw proofError
  }
  if (cleanupError) {
    throw cleanupError
  }
  if (!verifiedEvidence) {
    throw new Error('confinement proof completed without verified evidence')
  }
  const receipt = issueReceipt({ plan: input.plan, probe: initialProbe, ...verifiedEvidence })
  return Object.freeze({
    plan: input.plan,
    preparedLayout: input.preparedLayout,
    receipt
  })
}

function deriveTrustedProofPaths(
  plan: SealedCodexLabLaunchPlan
): Readonly<{ worktreeReadTarget: string; outsideWriteRoot: string }> {
  return Object.freeze({
    worktreeReadTarget: join(plan.cwd, '.git'),
    outsideWriteRoot: realpathSync(userInfo().homedir)
  })
}

export function isValidCodexLabHostReadinessReceipt(
  candidate: unknown
): candidate is CodexLabHostReadinessReceipt {
  if (!candidate || typeof candidate !== 'object') {
    return false
  }
  const receipt = issuedReceipts.get(candidate)
  if (!receipt) {
    return false
  }
  if (!RECEIPT_SHA.test(receipt.receiptSha256)) {
    return false
  }
  const { receiptSha256, ...stable } = receipt
  const expected = Buffer.from(sha256(JSON.stringify(stable)), 'hex')
  const actual = Buffer.from(receiptSha256, 'hex')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function assertImmediateHostEvidence(
  input: PrepareVerifiedCodexLabLaunchInput,
  host: CodexLabLiveConfinementHost,
  initialProbe: CodexLabTrustedFileObservation
): void {
  const codex = host.observeExecutable(input.plan.executable)
  if (
    codex.path !== input.plan.executable ||
    codex.observedRealPath !== input.plan.executable ||
    !codex.executable ||
    codex.sha256 !== input.plan.codexExecutableSha256
  ) {
    throw new Error('Codex executable identity or digest changed immediately before confinement')
  }
  const probe = host.observeExecutable(CODEX_LAB_LIVE_PROBE_EXECUTABLE)
  if (!isDeepStrictEqual(probe, initialProbe)) {
    throw new Error('trusted confinement probe identity or digest changed before execution')
  }
  const layout = host.observeLayout(input.preparedLayout)
  assertObservedLayout(input, layout, 'immediately before execution')
}

function assertPreparedLayoutEvidence(
  input: PrepareVerifiedCodexLabLaunchInput,
  host: CodexLabLiveConfinementHost
): void {
  assertObservedLayout(input, host.observeLayout(input.preparedLayout), 'after execution')
}

function assertObservedLayout(
  input: PrepareVerifiedCodexLabLaunchInput,
  layout: CodexLabTrustedLayoutObservation,
  phase: string
): void {
  if (!isDeepStrictEqual(layout, expectedLayoutObservation(input))) {
    throw new Error(`prepared confinement layout changed ${phase}`)
  }
}

function expectedLayoutObservation(
  input: PrepareVerifiedCodexLabLaunchInput
): CodexLabTrustedLayoutObservation {
  const prepared = input.preparedLayout
  return {
    dispatchRootIdentity: prepared.dispatchRootIdentity,
    codexHomeIdentity: prepared.codexHomeIdentity,
    fakeHomeIdentity: prepared.fakeHomeIdentity,
    configIdentity: prepared.configIdentity,
    configSha256: input.plan.receiptInputs.configSha256,
    authJson: 'absent'
  }
}

function issueReceipt(
  args: Readonly<{
    plan: SealedCodexLabLaunchPlan
    probe: CodexLabTrustedFileObservation
    controlsSha256: string
    probeReportSha256: string
    exactSpecSha256: string
  }>
): CodexLabHostReadinessReceipt {
  const stable = Object.freeze({
    schema: 'orca.codex-lab-host-readiness.v1' as const,
    dispatchId: args.plan.dispatchId,
    profile: args.plan.profile,
    adapter: args.plan.adapter,
    worktreeIdentity: args.plan.worktreeIdentity,
    worktreePath: args.plan.cwd,
    codexExecutableSha256: args.plan.codexExecutableSha256,
    configSha256: args.plan.receiptInputs.configSha256,
    probeExecutablePath: args.probe.path,
    probeExecutableSha256: args.probe.sha256,
    probeSourceSha256: CODEX_LAB_LIVE_PROBE_SOURCE_SHA256,
    controlsSha256: args.controlsSha256,
    probeReportSha256: args.probeReportSha256,
    exactSandboxSpecSha256: args.exactSpecSha256,
    controlTrust: 'trusted-local-host' as const,
    probeIdentityTrust: 'host-re-attested' as const,
    dispatchChannel: 'exact-unix-socket-permitted' as const,
    arbitraryNetwork: 'denied' as const,
    forbiddenWrites: 'denied' as const,
    worktreeRead: 'verified' as const,
    processTreeTermination: 'verified' as const,
    appServerAttestation: 'required-at-opened-thread-gate' as const
  })
  const receipt = Object.freeze({ ...stable, receiptSha256: sha256(JSON.stringify(stable)) })
  issuedReceipts.set(receipt, receipt)
  return receipt
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
