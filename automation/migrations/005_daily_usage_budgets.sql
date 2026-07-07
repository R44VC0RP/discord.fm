CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('TTS_CHARACTERS')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  reference_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX usage_events_daily_idx ON usage_events(kind, created_at);
