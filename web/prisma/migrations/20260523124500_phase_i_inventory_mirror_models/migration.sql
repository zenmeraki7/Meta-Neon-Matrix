-- Phase I: Inventory mirror models

ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "inventoryItemId" TEXT;

-- Legacy backfill: derive deterministic internal inventory item identity where missing
UPDATE "Variant"
SET "inventoryItemId" = CONCAT('LEGACY_VARIANT_ITEM:', "id")
WHERE "inventoryItemId" IS NULL;

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_inventoryItemId_idx"
ON "Variant"("shop", "mirrorBatchId", "inventoryItemId");

CREATE TABLE IF NOT EXISTS "InventoryItemMirror" (
  "shop" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "variantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "mirrorBatchId" TEXT NOT NULL,
  "tracked" BOOLEAN,
  "sku" TEXT,
  "cost" DECIMAL(20,6),
  "countryCodeOfOrigin" TEXT,
  "provinceCodeOfOrigin" TEXT,
  "harmonizedSystemCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryItemMirror_pkey" PRIMARY KEY ("shop", "id", "mirrorBatchId")
);

CREATE INDEX IF NOT EXISTS "InventoryItemMirror_shop_mirrorBatchId_variantId_idx"
ON "InventoryItemMirror"("shop", "mirrorBatchId", "variantId");

CREATE INDEX IF NOT EXISTS "InventoryItemMirror_shop_mirrorBatchId_productId_idx"
ON "InventoryItemMirror"("shop", "mirrorBatchId", "productId");

CREATE INDEX IF NOT EXISTS "InventoryItemMirror_shop_mirrorBatchId_tracked_idx"
ON "InventoryItemMirror"("shop", "mirrorBatchId", "tracked");

CREATE TABLE IF NOT EXISTS "InventoryLevelMirror" (
  "shop" TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "mirrorBatchId" TEXT NOT NULL,
  "available" INTEGER,
  "onHand" INTEGER,
  "committed" INTEGER,
  "incoming" INTEGER,
  "updatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryLevelMirror_pkey" PRIMARY KEY ("shop", "inventoryItemId", "locationId", "mirrorBatchId")
);

CREATE INDEX IF NOT EXISTS "InventoryLevelMirror_shop_mirrorBatchId_locationId_idx"
ON "InventoryLevelMirror"("shop", "mirrorBatchId", "locationId");

CREATE INDEX IF NOT EXISTS "InventoryLevelMirror_shop_mirrorBatchId_inventoryItemId_idx"
ON "InventoryLevelMirror"("shop", "mirrorBatchId", "inventoryItemId");

CREATE INDEX IF NOT EXISTS "InventoryLevelMirror_shop_mirrorBatchId_available_idx"
ON "InventoryLevelMirror"("shop", "mirrorBatchId", "available");

-- Backfill item mirror from existing Variant rows
INSERT INTO "InventoryItemMirror" (
  "shop", "id", "variantId", "productId", "mirrorBatchId", "tracked", "sku", "cost", "countryCodeOfOrigin", "harmonizedSystemCode", "createdAt", "updatedAt"
)
SELECT
  v."shop",
  v."inventoryItemId",
  v."id",
  v."productId",
  v."mirrorBatchId",
  v."tracked",
  v."sku",
  v."cost",
  v."countryOfOrigin",
  v."hsTariffCode",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Variant" v
WHERE v."inventoryItemId" IS NOT NULL
ON CONFLICT ("shop", "id", "mirrorBatchId") DO NOTHING;
