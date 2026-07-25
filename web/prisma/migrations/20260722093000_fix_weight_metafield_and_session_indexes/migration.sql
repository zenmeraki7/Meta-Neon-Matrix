-- This migration uses CONCURRENTLY and must not be wrapped in a transaction.

-- Store exact weight values and retain only active-batch filter coverage.
DROP INDEX CONCURRENTLY IF EXISTS "Variant_shop_weight_idx";

ALTER TABLE "Variant"
  ALTER COLUMN "weight" TYPE numeric(20, 6)
  USING round("weight"::numeric, 6);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Variant_shop_mirrorBatchId_weight_idx"
  ON "Variant" ("shop", "mirrorBatchId", "weight");

-- The tenant-scoped unique index already covers this exact lookup suffix.
DROP INDEX CONCURRENTLY IF EXISTS "variant_metafields_variant_id_namespace_key_idx";

-- Tenant-scoped operational and history retrieval for bulk-edit sessions.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "bulk_edit_sessions_shop_id_status_updated_at_idx"
  ON "bulk_edit_sessions" ("shop_id", "status", "updated_at");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "bulk_edit_sessions_shop_id_created_at_idx"
  ON "bulk_edit_sessions" ("shop_id", "created_at");
