-- Phase D: TargetSnapshot v2 (target identity + variant/inventory identity)

ALTER TABLE "TargetSnapshot"
  ADD COLUMN IF NOT EXISTS "targetType" TEXT,
  ADD COLUMN IF NOT EXISTS "variantId" TEXT,
  ADD COLUMN IF NOT EXISTS "collectionId" TEXT,
  ADD COLUMN IF NOT EXISTS "inventoryItemId" TEXT,
  ADD COLUMN IF NOT EXISTS "locationId" TEXT,
  ADD COLUMN IF NOT EXISTS "targetIdentity" TEXT,
  ADD COLUMN IF NOT EXISTS "ordinal" INTEGER,
  ADD COLUMN IF NOT EXISTS "shard" INTEGER,
  ADD COLUMN IF NOT EXISTS "beforeValues" JSONB,
  ADD COLUMN IF NOT EXISTS "filterHash" TEXT,
  ADD COLUMN IF NOT EXISTS "targetHash" TEXT;

UPDATE "TargetSnapshot"
SET
  "targetType" = COALESCE("targetType", 'PRODUCT'),
  "targetIdentity" = COALESCE("targetIdentity", 'PRODUCT:' || COALESCE("productId", '')),
  "mirrorBatchId" = COALESCE("mirrorBatchId", 'legacy_snapshot_batch');

ALTER TABLE "TargetSnapshot"
  ALTER COLUMN "targetType" SET NOT NULL,
  ALTER COLUMN "targetIdentity" SET NOT NULL,
  ALTER COLUMN "mirrorBatchId" SET NOT NULL,
  ALTER COLUMN "productId" DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'TargetSnapshot_shop_ownerType_ownerId_productId_key'
  ) THEN
    ALTER TABLE "TargetSnapshot"
      DROP CONSTRAINT "TargetSnapshot_shop_ownerType_ownerId_productId_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TargetSnapshot_shop_ownerType_ownerId_targetIdentity_key"
  ON "TargetSnapshot"("shop", "ownerType", "ownerId", "targetIdentity");

CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_owner_owner_batch_idx"
  ON "TargetSnapshot"("shop", "ownerType", "ownerId", "mirrorBatchId");

CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_batch_targetType_idx"
  ON "TargetSnapshot"("shop", "mirrorBatchId", "targetType");

CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_productId_idx"
  ON "TargetSnapshot"("shop", "productId");

CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_variantId_idx"
  ON "TargetSnapshot"("shop", "variantId");
