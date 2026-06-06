ALTER TABLE bulk_edit_changes
ADD COLUMN IF NOT EXISTS writing_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS bulk_edit_changes_stale_writing_idx
ON bulk_edit_changes (shop_id, session_id, writing_started_at)
WHERE status = 'WRITING';
