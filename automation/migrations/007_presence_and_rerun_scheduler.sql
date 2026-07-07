ALTER TABLE presence_state ADD COLUMN known INTEGER NOT NULL DEFAULT 0 CHECK (known IN (0,1));

CREATE INDEX cues_rerun_scheduler_idx ON cues(type, source, state, queue_position);
