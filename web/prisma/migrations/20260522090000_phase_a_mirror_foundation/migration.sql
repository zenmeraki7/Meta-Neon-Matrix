-- Phase A: additive mirror foundation
-- 1) Normalized collection links
CREATE TABLE IF NOT EXISTS "ProductCollection" (
  "shop" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "collectionId" TEXT NOT NULL,
  "mirrorBatchId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductCollection_pkey" PRIMARY KEY ("shop", "productId", "collectionId", "mirrorBatchId")
);

CREATE INDEX IF NOT EXISTS "ProductCollection_shop_mirrorBatchId_collectionId_idx"
  ON "ProductCollection"("shop", "mirrorBatchId", "collectionId");

CREATE INDEX IF NOT EXISTS "ProductCollection_shop_mirrorBatchId_productId_idx"
  ON "ProductCollection"("shop", "mirrorBatchId", "productId");

-- 2) Normalized metafield mirror
CREATE TABLE IF NOT EXISTS "MetafieldMirror" (
  "shop" TEXT NOT NULL,
  "ownerType" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "valueType" TEXT,
  "valueText" TEXT,
  "valueJson" JSONB,
  "mirrorBatchId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetafieldMirror_pkey" PRIMARY KEY ("shop", "ownerType", "ownerId", "namespace", "key", "mirrorBatchId")
);

CREATE INDEX IF NOT EXISTS "MetafieldMirror_shop_mirrorBatchId_ownerType_ownerId_idx"
  ON "MetafieldMirror"("shop", "mirrorBatchId", "ownerType", "ownerId");

CREATE INDEX IF NOT EXISTS "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueText_idx"
  ON "MetafieldMirror"("shop", "mirrorBatchId", "namespace", "key", "valueText");

-- 3) TargetSnapshot tenant-safe uniqueness (new index first; old unique dropped in Phase B)
CREATE UNIQUE INDEX IF NOT EXISTS "TargetSnapshot_shop_owner_product_uq"
  ON "TargetSnapshot"("shop", "ownerType", "ownerId", "productId");