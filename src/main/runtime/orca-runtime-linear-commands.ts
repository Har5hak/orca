// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithFileCommands } from './orca-runtime-file-commands'
import { RuntimeLinearCommands } from './runtime-linear-connection-commands'

export class OrcaRuntimeWithLinearCommands extends OrcaRuntimeWithFileCommands {
  // ── Linear integration ──

  readonly linearCommands = new RuntimeLinearCommands({
    runtimeAvailable: () => this.store !== null,
    showTerminal: (handle) => this.showTerminal(handle),
    resolveWorktreeSelector: (selector) => this.resolveWorktreeSelector(selector),
    listResolvedWorktrees: () => this.listResolvedWorktrees(),
    setWorktreeMeta: (worktreeId, meta) => this.store!.setWorktreeMeta(worktreeId, meta),
    emitClientEvent: (event) => this.emitClientEvent(event),
    beginMutationReceipt: ({ requestId, method, payloadHash }) => {
      const db = this.getOrchestrationDb()
      const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
      const result = db.beginMutationReceipt({ callerFingerprint, requestId, method, payloadHash })
      return { disposition: result.disposition, receipt: result.row.receipt }
    },
    checkpointMutationReceipt: ({ requestId, method, payloadHash, receipt }) => {
      const db = this.getOrchestrationDb()
      db.checkpointPendingMutationReceipt({
        callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
        requestId,
        method,
        payloadHash,
        receipt
      })
    },
    completeMutationReceipt: ({ requestId, method, payloadHash, receipt }) => {
      const db = this.getOrchestrationDb()
      db.completeMutationReceipt({
        callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
        requestId,
        method,
        payloadHash,
        receipt
      })
    },
    discardMutationReceipt: (requestId) => {
      const db = this.getOrchestrationDb()
      db.discardPendingMutationReceipt(db.getOrCreateLocalMutationCallerFingerprint(), requestId)
    }
  })
}
