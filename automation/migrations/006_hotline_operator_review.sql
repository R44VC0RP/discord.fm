ALTER TABLE hotline_candidates ADD COLUMN operator_override TEXT
  CHECK (operator_override IS NULL OR operator_override IN ('APPROVED','REJECTED','RESTORED'));
