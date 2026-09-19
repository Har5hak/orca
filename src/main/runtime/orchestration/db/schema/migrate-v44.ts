import type { OrchestrationDb } from '../orchestration-db'

export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  if (!this.hasColumn('codex_lab_runtime_custody', 'launch_receipt')) {
    this.db.exec('ALTER TABLE codex_lab_runtime_custody ADD COLUMN launch_receipt TEXT')
  }
  // A pre-v44 process can never supply the composite receipt required by the new ready transition.
  // Preserve its resource evidence, but make every unreleased row cleanup-only instead of
  // allowing an unverifiable launch to resume after restart. Re-running this repair is safe if
  // the column was added before a previous migration attempt stopped.
  this.db
    .prepare(
      `UPDATE codex_lab_runtime_custody
       SET state = 'cleanup_pending', revision = revision + 1, updated_at = datetime('now')
       WHERE state NOT IN ('cleanup_pending', 'released') AND launch_receipt IS NULL`
    )
    .run()
}
