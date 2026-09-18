import type { OrchestrationDb } from './orchestration/db'
import {
  isValidCodexLabHostPrerequisiteReceipt,
  type CodexLabHostPrerequisiteReceipt
} from './orchestration/lab-profile/codex-lab-host-prerequisites'
import { LAB_READONLY_SUPERVISED_PROFILE_ID } from './orchestration/lab-profile/codex-lab-launch-contract'
import { findWorkerProfileLeaseBlocker } from './orchestration/db/worker-dispatch/worker-dispatch-profile-lease'

export type RuntimeLabProfileReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{
      ready: false
      reason:
        | 'launch_pipeline_incomplete'
        | 'orchestration_state_unavailable'
        | 'profile_capacity_exhausted'
        | 'profile_cleanup_pending'
    }>

const HOST_NOT_VERIFIED = Object.freeze({
  ready: false,
  reason: 'launch_pipeline_incomplete'
} as const)
const ORCHESTRATION_STATE_UNAVAILABLE = Object.freeze({
  ready: false,
  reason: 'orchestration_state_unavailable'
} as const)
const PROFILE_CAPACITY_EXHAUSTED = Object.freeze({
  ready: false,
  reason: 'profile_capacity_exhausted'
} as const)
const PROFILE_CLEANUP_PENDING = Object.freeze({
  ready: false,
  reason: 'profile_cleanup_pending'
} as const)
const READY = Object.freeze({ ready: true } as const)

export class RuntimeLabProfileReadinessGate {
  private hostPrerequisites: CodexLabHostPrerequisiteReceipt | undefined

  constructor(private readonly getOrchestrationDb: () => OrchestrationDb | null) {}

  installHostPrerequisites(receipt: CodexLabHostPrerequisiteReceipt): void {
    if (!isValidCodexLabHostPrerequisiteReceipt(receipt)) {
      throw new Error('Refusing an unverified Codex laboratory host prerequisite receipt.')
    }
    this.hostPrerequisites = receipt
  }

  read(): RuntimeLabProfileReadiness {
    if (!this.hostPrerequisites) {
      return HOST_NOT_VERIFIED
    }
    const db = this.getOrchestrationDb()
    if (!db) {
      return ORCHESTRATION_STATE_UNAVAILABLE
    }
    try {
      const blocker = findWorkerProfileLeaseBlocker(db.db, LAB_READONLY_SUPERVISED_PROFILE_ID)
      if (!blocker) {
        return READY
      }
      return blocker.reason === 'cleanup_pending'
        ? PROFILE_CLEANUP_PENDING
        : PROFILE_CAPACITY_EXHAUSTED
    } catch {
      // Unreadable persisted cleanup cannot authorize a new profiled launch.
      return ORCHESTRATION_STATE_UNAVAILABLE
    }
  }
}
