CREATE TABLE dj_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lease_owner TEXT,
  lease_expires_at TEXT,
  cooldown_until TEXT,
  backoff_until TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  updated_at TEXT NOT NULL
);
INSERT INTO dj_state(singleton, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE dj_runs (
  id TEXT PRIMARY KEY,
  opencode_session_id TEXT,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RUNNING','COMPLETED','FAILED','ABORTED','NOOP')),
  snapshot_revision INTEGER NOT NULL,
  result_revision INTEGER,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL,
  failure_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX dj_runs_started_idx ON dj_runs(started_at DESC);

CREATE TABLE dj_tool_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dj_run_id TEXT REFERENCES dj_runs(id),
  opencode_session_id TEXT,
  tool_name TEXT NOT NULL,
  arguments_sha256 TEXT NOT NULL,
  result_code TEXT NOT NULL,
  pre_revision INTEGER,
  post_revision INTEGER,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX dj_tool_audit_run_idx ON dj_tool_audit(dj_run_id, id);

CREATE INDEX generation_jobs_claim_idx ON generation_jobs(state, claim_expires_at, created_at);
