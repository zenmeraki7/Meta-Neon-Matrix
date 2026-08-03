-- Kept transaction-safe so Prisma Migrate can replay it in the shadow database.
-- Only hidden products are indexed; visible and NULL rows incur no index entry.

DROP INDEX IF EXISTS "Product_shop_googleShoppingEnabled_idx";
DROP INDEX IF EXISTS "Product_shop_visibleOnlineStore_idx";
DROP INDEX IF EXISTS "Product_shop_mirrorBatchId_visibleOnlineStore_idx";

CREATE INDEX IF NOT EXISTS "product_active_hidden_idx"
  ON "Product" ("shop", "mirrorBatchId", "id")
  WHERE "visibleOnlineStore" = false;
