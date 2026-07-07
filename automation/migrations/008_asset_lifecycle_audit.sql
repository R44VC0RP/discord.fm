CREATE TABLE asset_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('RETIRED','RESTORED')),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  queue_revision INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX asset_events_history_idx ON asset_events(created_at DESC, id DESC);
