-- Phase G: ChangeRecord variant-aware undo fields

ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "targetType" TEXT;
ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "targetIdentity" TEXT;
ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "variantId" TEXT;
ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "mirrorBatchId" TEXT;
ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "beforeValues" JSONB;
ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "afterValues" JSONB;
ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "failureCode" TEXT;
ALTER TABLE "ChangeRecord" ADD COLUMN IF NOT EXISTS "failureMessage" TEXT;

-- Backfill existing rows into deterministic identity model
UPDATE "ChangeRecord"
SET
  "targetType" = CASE
    WHEN "targetType" IS NOT NULL THEN "targetType"
    WHEN "variantFieldChanges" IS NOT NULL THEN 'VARIANT'
    ELSE 'PRODUCT'
  END,
  "targetIdentity" = CASE
    WHEN "targetIdentity" IS NOT NULL THEN "targetIdentity"
    WHEN "variantFieldChanges" IS NOT NULL THEN CONCAT('PRODUCT:', "productId", ':MIXED')
    ELSE CONCAT('PRODUCT:', "productId")
  END
WHERE "targetType" IS NULL OR "targetIdentity" IS NULL;

ALTER TABLE "ChangeRecord" ALTER COLUMN "targetType" SET NOT NULL;
ALTER TABLE "ChangeRecord" ALTER COLUMN "targetIdentity" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_editHistoryId_idx"
ON "ChangeRecord"("shop", "editHistoryId");

CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_editHistoryId_targetType_idx"
ON "ChangeRecord"("shop", "editHistoryId", "targetType");

CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_editHistoryId_targetIdentity_idx"
ON "ChangeRecord"("shop", "editHistoryId", "targetIdentity");

CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_variantId_idx"
ON "ChangeRecord"("shop", "variantId");
