CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE queue_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO queue_meta(singleton, revision, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('music','spoken','hotline','rerun','station_id')),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING','READY','QUARANTINED','FAILED','RETIRED')),
  content_sha256 TEXT NOT NULL UNIQUE CHECK (length(content_sha256) = 64),
  source_locator TEXT NOT NULL,
  playout_locator TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
  mime_type TEXT NOT NULL,
  codec_name TEXT,
  sample_rate_hz INTEGER,
  channels INTEGER,
  bit_rate INTEGER,
  loudness_lufs REAL,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  probe_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT
);
CREATE INDEX assets_catalog_idx ON assets(kind, status, title, id);
CREATE TRIGGER assets_immutable_bytes
BEFORE UPDATE OF id, content_sha256, source_locator, playout_locator ON assets
BEGIN
  SELECT RAISE(ABORT, 'asset byte identity is immutable');
END;

CREATE TABLE cue_groups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('DRAFT','GENERATING','VALIDATING','READY','FAILED','CANCELED','COMPLETED')),
  admission TEXT NOT NULL DEFAULT 'ALL_CHILDREN_READY',
  failure_policy TEXT NOT NULL DEFAULT 'REJECT_GROUP',
  source TEXT NOT NULL,
  idempotency_key TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  script TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','RUNNING','READY','FAILED','CANCELED')),
  moderation_version INTEGER,
  output_asset_id TEXT REFERENCES assets(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','CLAIMED','RUNNING','COMPLETED','FAILED','CANCELED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT NOT NULL UNIQUE,
  claimed_by TEXT,
  claim_expires_at TEXT,
  provider_request_id TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cues (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('music','spoken','hotline','rerun','station_id','silence')),
  state TEXT NOT NULL CHECK (state IN ('DRAFT','GENERATING','VALIDATING','READY','CLAIMED','PLAYING','COMPLETED','INTERRUPTED','FAILED','CANCELED')),
  group_id TEXT REFERENCES cue_groups(id),
  group_index INTEGER,
  group_role TEXT,
  asset_id TEXT REFERENCES assets(id),
  generation_id TEXT REFERENCES generations(id),
  planned_duration_ms INTEGER NOT NULL CHECK (planned_duration_ms > 0),
  queue_position INTEGER NOT NULL,
  public_metadata_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  not_before TEXT,
  expires_at TEXT,
  resume_policy TEXT NOT NULL CHECK (resume_policy IN ('NEVER','RESUME')),
  transition_kind TEXT,
  transition_duration_ms INTEGER,
  moderation_version INTEGER,
  queue_revision_created INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claim_token TEXT,
  claim_expires_at TEXT,
  last_offset_ms INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  failure_code TEXT,
  failure_detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(group_id, group_index)
);
CREATE INDEX cues_queue_idx ON cues(state, queue_position, priority);
CREATE INDEX cues_asset_idx ON cues(asset_id);

CREATE TABLE hotline_candidates (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  transcript_private TEXT NOT NULL,
  redacted_transcript TEXT NOT NULL,
  summary_redacted TEXT,
  moderation_version INTEGER NOT NULL CHECK (moderation_version > 0),
  screen_version TEXT NOT NULL,
  screen_result TEXT NOT NULL CHECK (screen_result IN ('PASS','BADWORD','PII_UNCERTAIN','INVALID')),
  status TEXT NOT NULL CHECK (status IN ('ELIGIBLE','NEEDS_REVIEW','REJECTED','QUEUED','AIRED','ARCHIVED')),
  allowed_details_json TEXT NOT NULL DEFAULT '[]',
  aired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX hotline_eligible_idx ON hotline_candidates(status, created_at);

CREATE TABLE cue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cue_id TEXT REFERENCES cues(id),
  group_id TEXT REFERENCES cue_groups(id),
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  reason_code TEXT,
  queue_revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX cue_events_history_idx ON cue_events(created_at DESC, id DESC);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope, key)
);

CREATE TABLE presence_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  humans INTEGER NOT NULL CHECK (humans >= 0),
  observed_at TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO presence_state(singleton, humans, observed_at, worker_id, updated_at)
VALUES (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'bootstrap', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE scheduler_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
