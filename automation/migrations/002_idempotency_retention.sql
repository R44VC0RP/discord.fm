-- Lifecycle requests use one idempotency key per attempt. Keep enough history
-- for delayed retries while preventing an always-on station from growing this
-- table indefinitely.
CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys(created_at);
