import type { OrchestrationDb } from '../orchestration-db'

export const CODEX_LAB_RUNTIME_CUSTODY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS codex_lab_runtime_custody (
  dispatch_id                       TEXT PRIMARY KEY,
  profile_id                        TEXT NOT NULL
    CHECK(profile_id = 'lab-readonly-supervised-v1'),
  state                             TEXT NOT NULL
    CHECK(state IN (
      'planned', 'authority_attached', 'layout_prepared', 'provider_reserved',
      'gateway_started', 'external_auth_installed', 'provider_attached', 'ready',
      'cleanup_pending', 'released'
    )),
  runtime_root                      TEXT NOT NULL,
  runtime_parent_device             TEXT,
  runtime_parent_inode              TEXT,
  runtime_root_device               TEXT,
  runtime_root_inode                TEXT,
  config_sha256                     TEXT,
  auth_method                       TEXT CHECK(auth_method = 'chatgptAuthTokens'),
  auth_storage                      TEXT CHECK(auth_storage = 'ephemeral'),
  login_start_accepted              INTEGER CHECK(login_start_accepted IN (0, 1)),
  auth_json_absent                  INTEGER CHECK(auth_json_absent IN (0, 1)),
  gateway_public_receipt            TEXT,
  provider_id                       TEXT,
  provider_terminal_resource_id     TEXT,
  provider_session_sha256           TEXT,
  terminal_handle_sha256            TEXT,
  terminal_pane_key_sha256          TEXT,
  process_incarnation_sha256        TEXT,
  layout_cleanup_state              TEXT NOT NULL DEFAULT 'not_created'
    CHECK(layout_cleanup_state IN ('not_created', 'pending', 'failed', 'unproven', 'released')),
  layout_cleanup_reason_code        TEXT CHECK(layout_cleanup_reason_code IN (
    'release_failed', 'identity_unproven', 'process_exit_unproven',
    'host_unreachable', 'resource_busy', 'unexpected_error'
  )),
  layout_cleanup_detail_sha256      TEXT,
  auth_cleanup_state                TEXT NOT NULL DEFAULT 'not_created'
    CHECK(auth_cleanup_state IN ('not_created', 'pending', 'failed', 'unproven', 'released')),
  auth_cleanup_reason_code          TEXT CHECK(auth_cleanup_reason_code IN (
    'release_failed', 'identity_unproven', 'process_exit_unproven',
    'host_unreachable', 'resource_busy', 'unexpected_error'
  )),
  auth_cleanup_detail_sha256        TEXT,
  gateway_cleanup_state             TEXT NOT NULL DEFAULT 'not_created'
    CHECK(gateway_cleanup_state IN ('not_created', 'pending', 'failed', 'unproven', 'released')),
  gateway_cleanup_reason_code       TEXT CHECK(gateway_cleanup_reason_code IN (
    'release_failed', 'identity_unproven', 'process_exit_unproven',
    'host_unreachable', 'resource_busy', 'unexpected_error'
  )),
  gateway_cleanup_detail_sha256     TEXT,
  provider_cleanup_state            TEXT NOT NULL DEFAULT 'not_created'
    CHECK(provider_cleanup_state IN ('not_created', 'pending', 'failed', 'unproven', 'released')),
  provider_cleanup_reason_code      TEXT CHECK(provider_cleanup_reason_code IN (
    'release_failed', 'identity_unproven', 'process_exit_unproven',
    'host_unreachable', 'resource_busy', 'unexpected_error'
  )),
  provider_cleanup_detail_sha256    TEXT,
  revision                          INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  created_at                        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_codex_lab_runtime_residual_update_guard
BEFORE UPDATE OF residual_resources ON worker_dispatches
WHEN EXISTS (
  SELECT 1 FROM codex_lab_runtime_custody custody
  WHERE custody.dispatch_id = OLD.dispatch_id
    AND NEW.residual_resources != CASE custody.state
      WHEN 'released' THEN '[]'
      ELSE '[{"kind":"created_lab_runtime","id":"' || OLD.dispatch_id || '"}]'
    END
)
BEGIN
  SELECT RAISE(ABORT, 'codex lab runtime aggregate custody forbids residual mutation');
END;

CREATE TRIGGER IF NOT EXISTS trg_codex_lab_runtime_worker_delete_guard
BEFORE DELETE ON worker_dispatches
WHEN EXISTS (
  SELECT 1 FROM codex_lab_runtime_custody custody
  WHERE custody.dispatch_id = OLD.dispatch_id AND custody.state != 'released'
)
BEGIN
  SELECT RAISE(ABORT, 'codex lab runtime recovery record is unreleased');
END;

CREATE TRIGGER IF NOT EXISTS trg_codex_lab_runtime_custody_delete_guard
BEFORE DELETE ON codex_lab_runtime_custody
WHEN OLD.state != 'released'
BEGIN
  SELECT RAISE(ABORT, 'codex lab runtime recovery record is unreleased');
END;

CREATE TRIGGER IF NOT EXISTS trg_codex_lab_runtime_release_guard
BEFORE UPDATE OF state ON codex_lab_runtime_custody
WHEN NEW.state = 'released' AND (
  OLD.state != 'cleanup_pending'
  OR NEW.layout_cleanup_state NOT IN ('not_created', 'released')
  OR NEW.auth_cleanup_state NOT IN ('not_created', 'released')
  OR NEW.gateway_cleanup_state NOT IN ('not_created', 'released')
  OR NEW.provider_cleanup_state NOT IN ('not_created', 'released')
  OR NOT EXISTS (
    SELECT 1 FROM worker_dispatches worker
    WHERE worker.dispatch_id = OLD.dispatch_id
      AND worker.residual_resources =
        '[{"kind":"created_lab_runtime","id":"' || OLD.dispatch_id || '"}]'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'codex lab runtime release invariants are not proven');
END;

CREATE TRIGGER IF NOT EXISTS trg_codex_lab_runtime_release_residual
AFTER UPDATE OF state ON codex_lab_runtime_custody
WHEN OLD.state = 'cleanup_pending' AND NEW.state = 'released'
BEGIN
  UPDATE worker_dispatches
  SET residual_resources = '[]', updated_at = datetime('now')
  WHERE dispatch_id = NEW.dispatch_id;
END;
`

export function migrateV42(this: OrchestrationDb, current: number): void {
  if (current >= 42) {
    return
  }
  this.db.exec(CODEX_LAB_RUNTIME_CUSTODY_SCHEMA_SQL)
}
