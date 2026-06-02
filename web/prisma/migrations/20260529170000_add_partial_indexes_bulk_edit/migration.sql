-- Partial index hardening for bulk edit tables.
-- Prisma schema keeps @@index stubs for awareness, but true partial indexes
-- must be maintained in SQL migrations.

DO $$
BEGIN
  IF to_regclass('public.variant_metafields') IS NOT NULL THEN
    -- Drop likely Prisma-generated full indexes first.
    EXECUTE 'DROP INDEX IF EXISTS "variant_metafields_shop_id_is_dirty_idx"';
    EXECUTE 'DROP INDEX IF EXISTS "VariantMetafield_shopId_isDirty_idx"';

    EXECUTE '
      CREATE INDEX IF NOT EXISTS "variant_metafields_shop_id_is_dirty_partial_idx"
      ON variant_metafields (shop_id, is_dirty)
      WHERE is_dirty = true
    ';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.bulk_edit_changes') IS NOT NULL THEN
    -- Drop likely Prisma-generated full indexes first.
    EXECUTE 'DROP INDEX IF EXISTS "bulk_edit_changes_session_id_status_idx"';
    EXECUTE 'DROP INDEX IF EXISTS "BulkEditChange_sessionId_status_idx"';

    EXECUTE '
      CREATE INDEX IF NOT EXISTS "bulk_edit_changes_session_status_pending_idx"
      ON bulk_edit_changes (session_id, status)
      WHERE status IN (''PENDING'', ''WRITING'')
    ';

    EXECUTE '
      CREATE INDEX IF NOT EXISTS "bulk_edit_changes_retryable_idx"
      ON bulk_edit_changes (session_id)
      WHERE status = ''ERROR'' AND retryable = true
    ';
  END IF;
END $$;

