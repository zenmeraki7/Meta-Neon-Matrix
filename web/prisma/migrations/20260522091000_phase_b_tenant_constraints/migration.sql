-- Phase B: tenant constraint hardening and uniqueness cleanup

-- 0) Data cleanup for nullable shop-scoped tables
DELETE FROM "Collection"
WHERE "shop" IS NULL OR "shopifyId" IS NULL OR "mirrorBatchId" IS NULL;

DELETE FROM "SpreadsheetFile"
WHERE "shop" IS NULL;

DELETE FROM "FilterTrack"
WHERE "shop" IS NULL;

-- 1) Deduplicate Collection rows before unique index
DELETE FROM "Collection" c
USING "Collection" d
WHERE c.ctid < d.ctid
  AND c."shop" = d."shop"
  AND c."shopifyId" = d."shopifyId"
  AND c."mirrorBatchId" = d."mirrorBatchId";

-- 2) Enforce NOT NULL
ALTER TABLE "Collection" ALTER COLUMN "shop" SET NOT NULL;
ALTER TABLE "Collection" ALTER COLUMN "shopifyId" SET NOT NULL;
ALTER TABLE "Collection" ALTER COLUMN "mirrorBatchId" SET NOT NULL;

ALTER TABLE "SpreadsheetFile" ALTER COLUMN "shop" SET NOT NULL;
ALTER TABLE "FilterTrack" ALTER COLUMN "shop" SET NOT NULL;

-- 3) Enforce collection tenant uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS "Collection_shop_shopifyId_mirrorBatchId_key"
  ON "Collection"("shop", "shopifyId", "mirrorBatchId");

-- 4) Drop old cross-tenant TargetSnapshot unique and replace with tenant-safe name
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'TargetSnapshot_ownerType_ownerId_productId_key'
  ) THEN
    ALTER TABLE "TargetSnapshot"
      DROP CONSTRAINT "TargetSnapshot_ownerType_ownerId_productId_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "TargetSnapshot_shop_ownerType_ownerId_productId_key"
  ON "TargetSnapshot"("shop", "ownerType", "ownerId", "productId");