-- This migration uses CONCURRENTLY and must not be wrapped in a transaction.

-- BulkEditChange: materialize tenant ownership from the owning session.
ALTER TABLE "bulk_edit_changes"
  ADD COLUMN IF NOT EXISTS "shop_id" TEXT;

UPDATE "bulk_edit_changes" bec
SET "shop_id" = bes."shop_id"
FROM "bulk_edit_sessions" bes
WHERE bes."id" = bec."session_id"
  AND bec."shop_id" IS NULL;

-- Fail before constraints are changed if either owner belongs to another tenant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "bulk_edit_changes" bec
    JOIN "bulk_edit_sessions" bes ON bes."id" = bec."session_id"
    JOIN "variant_metafields" vm ON vm."id" = bec."variant_metafield_id"
    WHERE bec."shop_id" IS NULL
       OR bec."shop_id" <> bes."shop_id"
       OR bec."shop_id" <> vm."shop_id"
  ) THEN
    RAISE EXCEPTION 'BulkEditChange contains missing or cross-shop ownership';
  END IF;
END $$;

ALTER TABLE "bulk_edit_changes"
  ALTER COLUMN "shop_id" SET NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "bulk_edit_sessions_shop_id_id_key"
  ON "bulk_edit_sessions" ("shop_id", "id");

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "variant_metafields_shop_id_id_key"
  ON "variant_metafields" ("shop_id", "id");

ALTER TABLE "bulk_edit_changes"
  ADD CONSTRAINT "bulk_edit_changes_shop_session_fkey"
  FOREIGN KEY ("shop_id", "session_id")
  REFERENCES "bulk_edit_sessions" ("shop_id", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

ALTER TABLE "bulk_edit_changes"
  ADD CONSTRAINT "bulk_edit_changes_shop_variant_metafield_fkey"
  FOREIGN KEY ("shop_id", "variant_metafield_id")
  REFERENCES "variant_metafields" ("shop_id", "id")
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;

ALTER TABLE "bulk_edit_changes"
  VALIDATE CONSTRAINT "bulk_edit_changes_shop_session_fkey";

ALTER TABLE "bulk_edit_changes"
  VALIDATE CONSTRAINT "bulk_edit_changes_shop_variant_metafield_fkey";

ALTER TABLE "bulk_edit_changes"
  DROP CONSTRAINT IF EXISTS "bulk_edit_changes_session_id_fkey",
  DROP CONSTRAINT IF EXISTS "bulk_edit_changes_variant_metafield_id_fkey";

DROP INDEX CONCURRENTLY IF EXISTS "bulk_edit_changes_session_id_variant_metafield_id_key";
DROP INDEX CONCURRENTLY IF EXISTS "bulk_edit_changes_session_id_status_idx";
DROP INDEX CONCURRENTLY IF EXISTS "bulk_edit_changes_session_status_pending_idx";
DROP INDEX CONCURRENTLY IF EXISTS "bulk_edit_changes_retryable_idx";

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "bulk_edit_changes_shop_id_session_id_variant_metafield_id_key"
  ON "bulk_edit_changes" ("shop_id", "session_id", "variant_metafield_id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "bulk_edit_changes_shop_id_session_id_status_idx"
  ON "bulk_edit_changes" ("shop_id", "session_id", "status");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "bulk_edit_changes_shop_id_status_updated_at_idx"
  ON "bulk_edit_changes" ("shop_id", "status", "updated_at");

-- ChangeRecord: remove broad indexes and install tenant/workflow composites.
DROP INDEX CONCURRENTLY IF EXISTS "ChangeRecord_editHistoryId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ChangeRecord_shop_editHistoryId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ChangeRecord_shop_editHistoryId_targetType_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ChangeRecord_productId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ChangeRecord_shop_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ChangeRecord_status_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ChangeRecord_batchId_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChangeRecord_shop_editHistoryId_status_id_idx"
  ON "ChangeRecord" ("shop", "editHistoryId", "status", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChangeRecord_shop_editHistoryId_targetType_id_idx"
  ON "ChangeRecord" ("shop", "editHistoryId", "targetType", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChangeRecord_shop_productId_idx"
  ON "ChangeRecord" ("shop", "productId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChangeRecord_shop_batchId_idx"
  ON "ChangeRecord" ("shop", "batchId");

-- ChangeRecord_shop_variantId_idx and the target-identity index already match
-- tenant-scoped workflows and are intentionally retained.

-- ExportJob: normalized lifecycle fields are authoritative for filtering.
DROP INDEX CONCURRENTLY IF EXISTS "ExportJob_shop_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ExportJob_shop_executionState_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ExportJob_shop_executionStateNormalized_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ExportJob_status_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ExportJob_statusNormalized_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ExportJob_scheduledExportId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "ExportJob_scheduledExportRunId_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ExportJob_shop_statusNormalized_createdAt_idx"
  ON "ExportJob" ("shop", "statusNormalized", "createdAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ExportJob_shop_executionStateNormalized_updatedAt_idx"
  ON "ExportJob" ("shop", "executionStateNormalized", "updatedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ExportJob_shop_scheduledExportId_idx"
  ON "ExportJob" ("shop", "scheduledExportId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ExportJob_shop_scheduledExportRunId_idx"
  ON "ExportJob" ("shop", "scheduledExportRunId");
