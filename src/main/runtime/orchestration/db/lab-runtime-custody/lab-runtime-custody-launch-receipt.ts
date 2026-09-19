import { parseCodexLabLaunchReceipt } from '../../lab-profile/codex-lab-launch-receipt'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { OrchestrationDb } from '../orchestration-db'
import type {
  CodexLabRuntimeCustody,
  CodexLabRuntimeLaunchReceiptEvidence
} from './lab-runtime-custody-contract'
import { requireCustodyIdentity } from './lab-runtime-custody-row'
import { throwStateRefusal } from './lab-runtime-custody-state'
import { normalizeCodexLabCustodyIdentity, sha256 } from './lab-runtime-custody-validation'

export function recordCodexLabRuntimeLaunchReceipt(
  this: OrchestrationDb,
  input: CodexLabRuntimeLaunchReceiptEvidence
): CodexLabRuntimeCustody {
  const identity = normalizeCodexLabCustodyIdentity({
    dispatchId: input.dispatchId,
    profileId: input.profileId
  })
  const receipt = parseCodexLabLaunchReceipt(input.receipt, identity.dispatchId)
  const serialized = JSON.stringify(receipt)
  return runLifecycleWriteTransaction(this.db, 'record_codex_lab_launch_receipt', () => {
    const current = requireCustodyIdentity(this, identity)
    if (current.launchReceipt) {
      if (JSON.stringify(current.launchReceipt) === serialized) {
        return current
      }
      throw new Error('Codex laboratory launch receipt changed after persistence.')
    }
    const dispatch = this.getDispatchContextById(identity.dispatchId)
    const binding = receipt.gateway.policyReceipt.binding
    if (
      !dispatch ||
      !current.provider ||
      JSON.stringify(receipt.gateway) !== JSON.stringify(current.gatewayReceipt) ||
      binding.runIdSha256 !== sha256(dispatch.run_id) ||
      binding.taskIdSha256 !== sha256(dispatch.task_id) ||
      binding.dispatchIdSha256 !== sha256(dispatch.id) ||
      binding.terminalHandleSha256 !== current.provider.terminalHandleSha256 ||
      binding.terminalPaneKeySha256 !== current.provider.terminalPaneKeySha256 ||
      receipt.structuredAttach.providerProcessIncarnationSha256 !==
        current.provider.processIncarnationSha256
    ) {
      throw new Error('Codex laboratory launch receipt lifecycle binding is invalid.')
    }
    if (current.state !== 'provider_attached') {
      throwStateRefusal(identity.dispatchId, 'provider_attached', current.state)
    }
    const changed = this.db
      .prepare(
        `UPDATE codex_lab_runtime_custody
         SET launch_receipt = ?, revision = revision + 1, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'provider_attached' AND launch_receipt IS NULL`
      )
      .run(serialized, identity.dispatchId)
    if (changed.changes !== 1) {
      throw new Error('Codex laboratory launch receipt persistence lost its custody race.')
    }
    return requireCustodyIdentity(this, identity)
  })
}
