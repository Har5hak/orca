import type { OrchestrationDb } from '../orchestration-db'
import { TASK_DELIVERY_KEY_MAX_LENGTH } from '../../../../../shared/orchestration-task-delivery-key'

export const TASK_DELIVERY_KEY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_delivery_keys (
  delivery_key    TEXT PRIMARY KEY
    CHECK(length(delivery_key) BETWEEN 1 AND ${TASK_DELIVERY_KEY_MAX_LENGTH}
      AND instr(delivery_key, char(0)) = 0),
  contract_sha256 TEXT NOT NULL CHECK(length(contract_sha256) = 64),
  task_id         TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Old binaries know how to delete Tasks but not this additive registry.
CREATE TRIGGER IF NOT EXISTS trg_tasks_delete_delivery_key
AFTER DELETE ON tasks
BEGIN
  DELETE FROM task_delivery_keys WHERE task_id = OLD.id;
END;
`

export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current >= 42) {
    return
  }
  this.db.exec(TASK_DELIVERY_KEY_SCHEMA_SQL)
}
