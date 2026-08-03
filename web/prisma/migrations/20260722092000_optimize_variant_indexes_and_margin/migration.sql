-- Kept transaction-safe so Prisma Migrate can replay it in the shadow database.

-- Retire cross-batch core-field indexes. Variant_shop_productId_idx is retained
-- for the cross-batch product-delete webhook cleanup path.
DROP INDEX IF EXISTS "Variant_shop_sku_idx";
DROP INDEX IF EXISTS "Variant_shop_price_idx";
DROP INDEX IF EXISTS "Variant_shop_barcode_idx";
DROP INDEX IF EXISTS "Variant_shop_compareAtPrice_idx";
DROP INDEX IF EXISTS "Variant_shop_inventoryQuantity_idx";

-- The productId+position index covers the compact active-batch product prefix.
DROP INDEX IF EXISTS "Variant_shop_mirrorBatchId_productId_idx";
DROP INDEX IF EXISTS "Variant_shop_mirrorBatchId_productId_option1Value_idx";
DROP INDEX IF EXISTS "Variant_shop_mirrorBatchId_productId_option2Value_idx";
DROP INDEX IF EXISTS "Variant_shop_mirrorBatchId_productId_option3Value_idx";

-- Replace six full Boolean indexes with one selective operational index.
DROP INDEX IF EXISTS "Variant_shop_taxable_idx";
DROP INDEX IF EXISTS "Variant_shop_tracked_idx";
DROP INDEX IF EXISTS "Variant_shop_physicalProduct_idx";
DROP INDEX IF EXISTS "Variant_shop_mirrorBatchId_taxable_idx";
DROP INDEX IF EXISTS "Variant_shop_mirrorBatchId_tracked_idx";
DROP INDEX IF EXISTS "Variant_shop_mirrorBatchId_physicalProduct_idx";

CREATE INDEX IF NOT EXISTS "variant_active_untracked_idx"
  ON "Variant" ("shop", "mirrorBatchId", "id")
  WHERE "tracked" = false;

-- Preserve the filterable margin, but store exact fixed-point values.
DROP INDEX IF EXISTS "Variant_shop_profitMargin_idx";

ALTER TABLE "Variant"
  ALTER COLUMN "profitMargin" TYPE numeric(20, 6)
  USING round("profitMargin"::numeric, 6);
