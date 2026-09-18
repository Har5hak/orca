import {
  verifyCodexLabHostPrerequisites,
  type CodexLabHostPrerequisiteReceipt
} from './orchestration/lab-profile/codex-lab-host-prerequisites'

type LabProfileReadinessRuntime = Readonly<{
  getOrchestrationDb(): unknown
  installLabProfileHostPrerequisites(receipt: CodexLabHostPrerequisiteReceipt): void
}>

export type RuntimeLabProfileReadinessBootstrapResult =
  | Readonly<{ ready: true; receipt: CodexLabHostPrerequisiteReceipt }>
  | Readonly<{ ready: false; error: unknown }>

/** Runs once at each production runtime composition root; failure leaves the capability dark. */
export function bootstrapRuntimeLabProfileReadiness(
  runtime: LabProfileReadinessRuntime,
  verify: () => CodexLabHostPrerequisiteReceipt = verifyCodexLabHostPrerequisites
): RuntimeLabProfileReadinessBootstrapResult {
  try {
    const receipt = verify()
    // Readiness consults the persisted lease/cleanup state synchronously. Open it here so
    // capability discovery cannot depend on an earlier orchestration request doing that work.
    runtime.getOrchestrationDb()
    runtime.installLabProfileHostPrerequisites(receipt)
    return Object.freeze({ ready: true, receipt })
  } catch (error) {
    return Object.freeze({ ready: false, error })
  }
}
