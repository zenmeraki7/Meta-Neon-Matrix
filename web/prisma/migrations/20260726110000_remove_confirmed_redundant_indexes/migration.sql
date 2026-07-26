-- These indexes are covered by the leftmost prefix of an existing primary,
-- unique, or query-shaped B-tree index. Removing them reduces write and WAL
-- amplification without removing a supported lookup path.
DROP INDEX CONCURRENTLY IF EXISTS "EditHistory_shop_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Location_shop_idx";
DROP INDEX CONCURRENTLY IF EXISTS "OperationLease_shop_namespace_idx";
DROP INDEX CONCURRENTLY IF EXISTS "OperationStageProgress_shop_operationType_operationId_idx";

-- Import history is retrieved with stable descending cursor pagination.
-- Replace the shop-only index rather than retaining both indexes.
DROP INDEX CONCURRENTLY IF EXISTS "SpreadsheetFile_shop_idx";
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SpreadsheetFile_shop_createdAt_id_idx"
  ON "SpreadsheetFile" ("shop", "createdAt", "id");
