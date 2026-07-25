-- Neon/PostgreSQL mirror ownership hardening.
-- The preflight deliberately aborts before constraints are changed if legacy
-- orphaned or cross-tenant rows exist. Repair those rows, then rerun migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Product" c
    LEFT JOIN "MirrorBatch" b ON b."shop" = c."shop" AND b."id" = c."mirrorBatchId"
    WHERE b."id" IS NULL
  ) THEN RAISE EXCEPTION 'Product contains an orphan or cross-shop mirrorBatchId'; END IF;

  IF EXISTS (
    SELECT 1 FROM "Collection" c
    LEFT JOIN "MirrorBatch" b ON b."shop" = c."shop" AND b."id" = c."mirrorBatchId"
    WHERE b."id" IS NULL
  ) THEN RAISE EXCEPTION 'Collection contains an orphan or cross-shop mirrorBatchId'; END IF;

  IF EXISTS (
    SELECT 1 FROM "MetafieldMirror" c
    LEFT JOIN "MirrorBatch" b ON b."shop" = c."shop" AND b."id" = c."mirrorBatchId"
    WHERE b."id" IS NULL
  ) THEN RAISE EXCEPTION 'MetafieldMirror contains an orphan or cross-shop mirrorBatchId'; END IF;

  IF EXISTS (
    SELECT 1 FROM "TargetSnapshot" c
    LEFT JOIN "MirrorBatch" b ON b."shop" = c."shop" AND b."id" = c."mirrorBatchId"
    WHERE b."id" IS NULL
  ) THEN RAISE EXCEPTION 'TargetSnapshot contains an orphan or cross-shop mirrorBatchId'; END IF;

  IF EXISTS (
    SELECT 1 FROM "TargetSnapshotSet" c
    LEFT JOIN "MirrorBatch" b ON b."shop" = c."shop" AND b."id" = c."mirrorBatchId"
    WHERE b."id" IS NULL
  ) THEN RAISE EXCEPTION 'TargetSnapshotSet contains an orphan or cross-shop mirrorBatchId'; END IF;

  IF EXISTS (
    SELECT 1 FROM "ProductMediaMirror" c
    LEFT JOIN "Product" p ON p."shop" = c."shop" AND p."id" = c."productId" AND p."mirrorBatchId" = c."mirrorBatchId"
    WHERE p."id" IS NULL
  ) THEN RAISE EXCEPTION 'ProductMediaMirror contains an orphan or cross-batch product'; END IF;

  IF EXISTS (
    SELECT 1 FROM "InventoryItemMirror" c
    LEFT JOIN "Product" p ON p."shop" = c."shop" AND p."id" = c."productId" AND p."mirrorBatchId" = c."mirrorBatchId"
    LEFT JOIN "Variant" v ON v."shop" = c."shop" AND v."id" = c."variantId" AND v."mirrorBatchId" = c."mirrorBatchId"
    WHERE p."id" IS NULL OR v."id" IS NULL
  ) THEN RAISE EXCEPTION 'InventoryItemMirror contains an orphan or cross-batch parent'; END IF;

  IF EXISTS (
    SELECT 1 FROM "InventoryLevelMirror" c
    LEFT JOIN "InventoryItemMirror" i ON i."shop" = c."shop" AND i."id" = c."inventoryItemId" AND i."mirrorBatchId" = c."mirrorBatchId"
    WHERE i."id" IS NULL
  ) THEN RAISE EXCEPTION 'InventoryLevelMirror contains an orphan or cross-batch inventory item'; END IF;

  IF EXISTS (
    SELECT 1 FROM "ProductCollection" c
    LEFT JOIN "Product" p ON p."shop" = c."shop" AND p."id" = c."productId" AND p."mirrorBatchId" = c."mirrorBatchId"
    LEFT JOIN "Collection" k ON k."shop" = c."shop" AND k."shopifyId" = c."collectionId" AND k."mirrorBatchId" = c."mirrorBatchId"
    WHERE p."id" IS NULL OR k."shopifyId" IS NULL
  ) THEN RAISE EXCEPTION 'ProductCollection contains an orphan or cross-batch parent'; END IF;

  IF EXISTS (
    SELECT 1 FROM "TargetSnapshotItem" i
    LEFT JOIN "TargetSnapshotSet" s ON s."shop" = i."shop" AND s."id" = i."snapshotSetId" AND s."mirrorBatchId" = i."mirrorBatchId"
    WHERE s."id" IS NULL
  ) THEN RAISE EXCEPTION 'TargetSnapshotItem contains an orphan or cross-batch snapshot set'; END IF;

  IF EXISTS (
    SELECT 1 FROM "ProductTombstone" c LEFT JOIN "Store" s ON s."shopUrl" = c."shop" WHERE s."shopUrl" IS NULL
  ) THEN RAISE EXCEPTION 'ProductTombstone contains an unknown shop'; END IF;

  IF EXISTS (
    SELECT 1 FROM "MirrorMutationJournal" c LEFT JOIN "Store" s ON s."shopUrl" = c."shop" WHERE s."shopUrl" IS NULL
  ) THEN RAISE EXCEPTION 'MirrorMutationJournal contains an unknown shop'; END IF;
END $$;

-- Reuse the existing composite unique indexes as primary keys, avoiding a
-- second index build. PostgreSQL renames each adopted index to *_pkey.
ALTER TABLE "MirrorBatch" DROP CONSTRAINT "MirrorBatch_pkey";
ALTER TABLE "MirrorBatch" ADD CONSTRAINT "MirrorBatch_pkey"
  PRIMARY KEY USING INDEX "MirrorBatch_shop_id_key";

ALTER TABLE "Collection" DROP CONSTRAINT "Collection_pkey";
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_pkey"
  PRIMARY KEY USING INDEX "Collection_shop_shopifyId_mirrorBatchId_key";
ALTER TABLE "Collection" DROP COLUMN "id";

ALTER TABLE "ProductTombstone" DROP CONSTRAINT "ProductTombstone_pkey";
ALTER TABLE "ProductTombstone" ADD CONSTRAINT "ProductTombstone_pkey"
  PRIMARY KEY USING INDEX "ProductTombstone_shop_productId_key";
ALTER TABLE "ProductTombstone" DROP COLUMN "id";

CREATE UNIQUE INDEX "TargetSnapshotSet_shop_id_mirrorBatchId_key"
  ON "TargetSnapshotSet" ("shop", "id", "mirrorBatchId");

ALTER TABLE "Variant" DROP CONSTRAINT IF EXISTS "Variant_shop_productId_mirrorBatchId_fkey";
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_shop_productId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "productId", "mirrorBatchId") REFERENCES "Product" ("shop", "id", "mirrorBatchId")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Product" ADD CONSTRAINT "Product_shop_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "mirrorBatchId") REFERENCES "MirrorBatch" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_shop_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "mirrorBatchId") REFERENCES "MirrorBatch" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "MetafieldMirror" ADD CONSTRAINT "MetafieldMirror_shop_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "mirrorBatchId") REFERENCES "MirrorBatch" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TargetSnapshot" ADD CONSTRAINT "TargetSnapshot_shop_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "mirrorBatchId") REFERENCES "MirrorBatch" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_shop_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "mirrorBatchId") REFERENCES "MirrorBatch" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ProductMediaMirror" ADD CONSTRAINT "ProductMediaMirror_shop_productId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "productId", "mirrorBatchId") REFERENCES "Product" ("shop", "id", "mirrorBatchId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "InventoryItemMirror" ADD CONSTRAINT "InventoryItemMirror_shop_productId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "productId", "mirrorBatchId") REFERENCES "Product" ("shop", "id", "mirrorBatchId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "InventoryItemMirror" ADD CONSTRAINT "InventoryItemMirror_shop_variantId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "variantId", "mirrorBatchId") REFERENCES "Variant" ("shop", "id", "mirrorBatchId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "InventoryLevelMirror" ADD CONSTRAINT "InventoryLevelMirror_shop_inventoryItemId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "inventoryItemId", "mirrorBatchId") REFERENCES "InventoryItemMirror" ("shop", "id", "mirrorBatchId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ProductCollection" ADD CONSTRAINT "ProductCollection_shop_productId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "productId", "mirrorBatchId") REFERENCES "Product" ("shop", "id", "mirrorBatchId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ProductCollection" ADD CONSTRAINT "ProductCollection_shop_collectionId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "collectionId", "mirrorBatchId") REFERENCES "Collection" ("shop", "shopifyId", "mirrorBatchId") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "ProductTombstone" ADD CONSTRAINT "ProductTombstone_shop_fkey"
  FOREIGN KEY ("shop") REFERENCES "Store" ("shopUrl") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "MirrorMutationJournal" ADD CONSTRAINT "MirrorMutationJournal_shop_fkey"
  FOREIGN KEY ("shop") REFERENCES "Store" ("shopUrl") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "TargetSnapshotItem" DROP CONSTRAINT IF EXISTS "TargetSnapshotItem_shop_snapshotSetId_fkey";
ALTER TABLE "TargetSnapshotItem" DROP CONSTRAINT IF EXISTS "TargetSnapshotItem_snapshotSetId_fkey";
ALTER TABLE "TargetSnapshotItem" ADD CONSTRAINT "TargetSnapshotItem_shop_snapshotSetId_mirrorBatchId_fkey"
  FOREIGN KEY ("shop", "snapshotSetId", "mirrorBatchId") REFERENCES "TargetSnapshotSet" ("shop", "id", "mirrorBatchId")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

ALTER TABLE "EditHistory" DROP CONSTRAINT IF EXISTS "EditHistory_snapshotSetId_fkey";
ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_snapshotSetId_fkey"
  FOREIGN KEY ("snapshotSetId") REFERENCES "TargetSnapshotSet" ("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "Variant" VALIDATE CONSTRAINT "Variant_shop_productId_mirrorBatchId_fkey";
ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_shop_mirrorBatchId_fkey";
ALTER TABLE "Collection" VALIDATE CONSTRAINT "Collection_shop_mirrorBatchId_fkey";
ALTER TABLE "MetafieldMirror" VALIDATE CONSTRAINT "MetafieldMirror_shop_mirrorBatchId_fkey";
ALTER TABLE "TargetSnapshot" VALIDATE CONSTRAINT "TargetSnapshot_shop_mirrorBatchId_fkey";
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_shop_mirrorBatchId_fkey";
ALTER TABLE "ProductMediaMirror" VALIDATE CONSTRAINT "ProductMediaMirror_shop_productId_mirrorBatchId_fkey";
ALTER TABLE "InventoryItemMirror" VALIDATE CONSTRAINT "InventoryItemMirror_shop_productId_mirrorBatchId_fkey";
ALTER TABLE "InventoryItemMirror" VALIDATE CONSTRAINT "InventoryItemMirror_shop_variantId_mirrorBatchId_fkey";
ALTER TABLE "InventoryLevelMirror" VALIDATE CONSTRAINT "InventoryLevelMirror_shop_inventoryItemId_mirrorBatchId_fkey";
ALTER TABLE "ProductCollection" VALIDATE CONSTRAINT "ProductCollection_shop_productId_mirrorBatchId_fkey";
ALTER TABLE "ProductCollection" VALIDATE CONSTRAINT "ProductCollection_shop_collectionId_mirrorBatchId_fkey";
ALTER TABLE "ProductTombstone" VALIDATE CONSTRAINT "ProductTombstone_shop_fkey";
ALTER TABLE "MirrorMutationJournal" VALIDATE CONSTRAINT "MirrorMutationJournal_shop_fkey";
ALTER TABLE "TargetSnapshotItem" VALIDATE CONSTRAINT "TargetSnapshotItem_shop_snapshotSetId_mirrorBatchId_fkey";
ALTER TABLE "EditHistory" VALIDATE CONSTRAINT "EditHistory_snapshotSetId_fkey";
