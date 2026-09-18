import type { OrchestrationDb } from '../orchestration-db'

export function migrateV43(this: OrchestrationDb, current: number): void {
  if (current >= 43 || this.hasColumn('runs', 'codex_usage_authorization')) {
    return
  }
  this.db.exec('ALTER TABLE runs ADD COLUMN codex_usage_authorization TEXT')
}
