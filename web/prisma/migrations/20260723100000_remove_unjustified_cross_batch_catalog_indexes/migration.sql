-- Interactive catalog reads are scoped to (shop, mirrorBatchId). Keep only the
-- confirmed cross-batch Variant(shop, productId) index used by product deletion.
-- This migration must run without an enclosing transaction because PostgreSQL
-- Build replacement indexes before removing the old indexes.

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_googleShoppingCondition_idx"
  ON "Product" ("shop", "mirrorBatchId", "googleShoppingCondition");
CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_googleShoppingGender_idx"
  ON "Product" ("shop", "mirrorBatchId", "googleShoppingGender");
CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_googleShoppingAgeGroup_idx"
  ON "Product" ("shop", "mirrorBatchId", "googleShoppingAgeGroup");
CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_title_idx"
  ON "Variant" ("shop", "mirrorBatchId", "title");
CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_cost_idx"
  ON "Variant" ("shop", "mirrorBatchId", "cost");
CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_hsTariffCode_idx"
  ON "Variant" ("shop", "mirrorBatchId", "hsTariffCode");

DROP INDEX IF EXISTS "Product_shop_statusNormalized_idx";
DROP INDEX IF EXISTS "Product_shop_publishedAt_idx";
DROP INDEX IF EXISTS "Product_shop_categoryName_idx";
DROP INDEX IF EXISTS "Product_shop_googleShoppingCategory_idx";
DROP INDEX IF EXISTS "Product_shop_googleShoppingCondition_idx";
DROP INDEX IF EXISTS "Product_shop_googleShoppingGender_idx";
DROP INDEX IF EXISTS "Product_shop_googleShoppingAgeGroup_idx";
DROP INDEX IF EXISTS "Product_shop_categoryColor_idx";
DROP INDEX IF EXISTS "Product_shop_categorySize_idx";
DROP INDEX IF EXISTS "Product_shop_categoryTargetGender_idx";
DROP INDEX IF EXISTS "Product_shop_templateSuffix_idx";
DROP INDEX IF EXISTS "Product_shop_option1Name_idx";
DROP INDEX IF EXISTS "Product_shop_option2Name_idx";
DROP INDEX IF EXISTS "Product_shop_option3Name_idx";
DROP INDEX IF EXISTS "Product_shop_variantCount_idx";
DROP INDEX IF EXISTS "Product_shop_lastReconciledAt_idx";
DROP INDEX IF EXISTS "Product_shop_lastSourceEventAt_idx";
DROP INDEX IF EXISTS "Product_shop_lastSourceKind_idx";
DROP INDEX IF EXISTS "Product_shop_lastSourceUpdatedAt_idx";

DROP INDEX IF EXISTS "Variant_shop_title_idx";
DROP INDEX IF EXISTS "Variant_shop_cost_idx";
DROP INDEX IF EXISTS "Variant_shop_inventoryPolicy_idx";
DROP INDEX IF EXISTS "Variant_shop_weightUnit_idx";
DROP INDEX IF EXISTS "Variant_shop_countryOfOrigin_idx";
DROP INDEX IF EXISTS "Variant_shop_hsTariffCode_idx";
DROP INDEX IF EXISTS "Variant_shop_option1Value_idx";
DROP INDEX IF EXISTS "Variant_shop_option2Value_idx";
DROP INDEX IF EXISTS "Variant_shop_option3Value_idx";
