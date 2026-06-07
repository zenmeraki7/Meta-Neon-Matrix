ALTER TABLE bulk_edit_changes
ADD COLUMN IF NOT EXISTS writing_started_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'bulk_edit_changes'
      AND column_name = 'shop_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS bulk_edit_changes_stale_writing_idx
      ON bulk_edit_changes (shop_id, session_id, writing_started_at)
      WHERE status = 'WRITING';
  END IF;
END
$$;
