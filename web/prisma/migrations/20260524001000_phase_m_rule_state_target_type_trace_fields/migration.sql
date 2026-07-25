DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'AutomaticProductRuleTargetType'
  ) THEN
    CREATE TYPE "AutomaticProductRuleTargetType" AS ENUM ('PRODUCT', 'VARIANT');
  END IF;
END $$;

ALTER TABLE "AutomaticProductRuleProductState"
  ADD COLUMN IF NOT EXISTS "targetType" TEXT,
  ADD COLUMN IF NOT EXISTS "lastMirrorBatchId" TEXT,
  ADD COLUMN IF NOT EXISTS "lastTriggerReference" TEXT,
  ADD COLUMN IF NOT EXISTS "lastRunId" TEXT;

ALTER TABLE "AutomaticProductRuleProductState"
  ALTER COLUMN "targetType" DROP DEFAULT;

UPDATE "AutomaticProductRuleProductState"
SET "targetType" = 'PRODUCT'
WHERE "targetType" IS NULL
   OR "targetType" = '';

ALTER TABLE "AutomaticProductRuleProductState"
  ALTER COLUMN "targetType" TYPE "AutomaticProductRuleTargetType"
  USING (
    CASE
      WHEN UPPER(COALESCE("targetType"::text, '')) = 'VARIANT'
        THEN 'VARIANT'
      ELSE 'PRODUCT'
    END::"AutomaticProductRuleTargetType"
  );

ALTER TABLE "AutomaticProductRuleProductState"
  ALTER COLUMN "targetType" SET DEFAULT 'PRODUCT'::"AutomaticProductRuleTargetType",
  ALTER COLUMN "targetType" SET NOT NULL;

UPDATE "AutomaticProductRuleProductState"
SET "targetIdentity" = 'PRODUCT:' || COALESCE("productId", '')
WHERE "targetIdentity" IS NULL
  OR "targetIdentity" = '';

ALTER TABLE "AutomaticProductRuleProductState"
  ALTER COLUMN "targetIdentity" SET NOT NULL;

ALTER TABLE "AutomaticProductRuleProductState"
  DROP CONSTRAINT IF EXISTS "AutomaticProductRuleProductState_automaticProductRuleId_shop_productId_key";

DROP INDEX IF EXISTS "AutomaticProductRuleProductState_automaticProductRuleId_sho_key";

CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticRuleState_rule_shop_targetIdentity_key"
  ON "AutomaticProductRuleProductState" ("automaticProductRuleId", "shop", "targetIdentity");

CREATE INDEX IF NOT EXISTS "AutomaticRuleState_shop_targetType_product_idx"
  ON "AutomaticProductRuleProductState" ("shop", "targetType", "productId");

CREATE INDEX IF NOT EXISTS "AutomaticRuleState_shop_targetType_variant_idx"
  ON "AutomaticProductRuleProductState" ("shop", "targetType", "variantId");

CREATE INDEX IF NOT EXISTS "AutomaticRuleState_rule_suppressed_idx"
  ON "AutomaticProductRuleProductState" ("automaticProductRuleId", "suppressedUntil");

CREATE INDEX IF NOT EXISTS "AutomaticRuleState_rule_targetType_idx"
  ON "AutomaticProductRuleProductState" ("automaticProductRuleId", "targetType");

CREATE INDEX IF NOT EXISTS "AutomaticRuleState_shop_product_idx"
  ON "AutomaticProductRuleProductState" ("shop", "productId");

CREATE INDEX IF NOT EXISTS "AutomaticRuleState_shop_variant_idx"
  ON "AutomaticProductRuleProductState" ("shop", "variantId");

CREATE INDEX IF NOT EXISTS "AutomaticRuleState_shop_batch_idx"
  ON "AutomaticProductRuleProductState" ("shop", "lastMirrorBatchId");