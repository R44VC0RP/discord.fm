ALTER TABLE hotline_candidates ADD COLUMN archive_reason TEXT;
UPDATE hotline_candidates
SET archive_reason = CASE
  WHEN status='AIRED' THEN 'AIRED'
  WHEN status='ARCHIVED' THEN 'LEGACY_ARCHIVED'
  ELSE NULL
END;
