-- This migration uses CONCURRENTLY and must not be wrapped in a transaction.
-- Only hidden products are indexed; visible and NULL rows incur no index entry.

DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_googleShoppingEnabled_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_visibleOnlineStore_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_visibleOnlineStore_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "product_active_hidden_idx"
  ON "Product" ("shop", "mirrorBatchId", "id")
  WHERE "visibleOnlineStore" = false;
