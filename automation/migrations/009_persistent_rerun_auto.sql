CREATE TABLE automation_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL
) STRICT;

-- Preserve the pre-migration scheduler behavior. Later operator changes are
-- durable and are never overwritten by environment defaults or restarts.
INSERT INTO automation_settings(key,value_json,version,updated_at)
VALUES('rerun_auto','{"enabled":true}',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
