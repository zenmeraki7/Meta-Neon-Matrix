ALTER TABLE "Product" ADD COLUMN "sourceVersion" TEXT, ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "Product" SET "lastSourceUpdatedAt" = COALESCE("lastSourceUpdatedAt", "updatedAt"),
  "lastSourceEventAt" = COALESCE("lastSourceEventAt", "updatedAt");

ALTER TABLE "Variant" ADD COLUMN "sourceEntityUpdatedAt" TIMESTAMP(3), ADD COLUMN "sourceEventOccurredAt" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT, ADD COLUMN "lastChangeSource" TEXT,
  ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3), ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE;
-- Variant has no legacy createdAt/updatedAt authority. Existing rows retain
-- NULL source timestamps until an authoritative source event supplies them.

ALTER TABLE "Collection" ADD COLUMN "sourceEntityUpdatedAt" TIMESTAMP(3), ADD COLUMN "sourceEventOccurredAt" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT, ADD COLUMN "lastChangeSource" TEXT,
  ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3), ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "Collection" SET "sourceEntityUpdatedAt" = "updatedAt", "sourceEventOccurredAt" = "updatedAt";

ALTER TABLE "InventoryItemMirror" ADD COLUMN "sourceEntityUpdatedAt" TIMESTAMP(3), ADD COLUMN "sourceEventOccurredAt" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT, ADD COLUMN "lastChangeSource" TEXT,
  ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3), ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "InventoryItemMirror" SET "sourceEntityUpdatedAt" = "updatedAt", "sourceEventOccurredAt" = "updatedAt";

ALTER TABLE "InventoryLevelMirror" ADD COLUMN "sourceEntityUpdatedAt" TIMESTAMP(3), ADD COLUMN "sourceEventOccurredAt" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT, ADD COLUMN "lastChangeSource" TEXT,
  ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3), ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "InventoryLevelMirror" SET "sourceEntityUpdatedAt" = "updatedAt", "sourceEventOccurredAt" = "updatedAt";

ALTER TABLE "MetafieldMirror" ADD COLUMN "valueDigest" TEXT, ADD COLUMN "compareDigest" TEXT,
  ADD COLUMN "sourceEntityUpdatedAt" TIMESTAMP(3), ADD COLUMN "sourceEventOccurredAt" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT, ADD COLUMN "lastChangeSource" TEXT,
  ADD COLUMN "reconciliationCompletedAt" TIMESTAMP(3), ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE "MetafieldMirror" SET "sourceEntityUpdatedAt" = "updatedAt", "sourceEventOccurredAt" = "updatedAt",
  "valueDigest" = md5(COALESCE("valueText", "valueJson"::text, "valueNumber"::text, "valueBoolean"::text, "valueDate"::text, 'null'));

ALTER TABLE "ProductTombstone" ADD COLUMN "sourceVersion" TEXT;

CREATE TABLE "VariantTombstone" (
  "shop" TEXT NOT NULL, "variantId" TEXT NOT NULL, "productId" TEXT,
  "tombstoneMutationSequence" BIGINT NOT NULL, "sourceEntityUpdatedAt" TIMESTAMP(3),
  "sourceEventOccurredAt" TIMESTAMP(3), "sourceVersion" TEXT, "lastChangeSource" TEXT,
  "deletedAt" TIMESTAMP(3), "reconciliationCompletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("shop", "variantId")
);
CREATE INDEX "VariantTombstone_shop_tombstoneMutationSequence_idx" ON "VariantTombstone"("shop", "tombstoneMutationSequence");
CREATE TABLE "MetafieldTombstone" (
  "shop" TEXT NOT NULL, "ownerType" TEXT NOT NULL, "ownerId" TEXT NOT NULL, "namespace" TEXT NOT NULL, "key" TEXT NOT NULL,
  "tombstoneMutationSequence" BIGINT NOT NULL, "sourceEventOccurredAt" TIMESTAMP(3), "sourceVersion" TEXT,
  "lastChangeSource" TEXT, "valueDigest" TEXT, "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("shop", "ownerType", "ownerId", "namespace", "key")
);
CREATE INDEX "MetafieldTombstone_shop_tombstoneMutationSequence_idx" ON "MetafieldTombstone"("shop", "tombstoneMutationSequence");
CREATE TABLE "InventoryItemTombstone" (
  "shop" TEXT NOT NULL, "inventoryItemId" TEXT NOT NULL, "productId" TEXT, "variantId" TEXT,
  "tombstoneMutationSequence" BIGINT NOT NULL, "sourceEventOccurredAt" TIMESTAMP(3), "sourceVersion" TEXT,
  "lastChangeSource" TEXT, "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("shop", "inventoryItemId")
);
CREATE INDEX "InventoryItemTombstone_shop_tombstoneMutationSequence_idx" ON "InventoryItemTombstone"("shop", "tombstoneMutationSequence");
CREATE TABLE "CollectionTombstone" (
  "shop" TEXT NOT NULL, "collectionId" TEXT NOT NULL, "tombstoneMutationSequence" BIGINT NOT NULL,
  "sourceEntityUpdatedAt" TIMESTAMP(3), "sourceEventOccurredAt" TIMESTAMP(3), "sourceVersion" TEXT,
  "lastChangeSource" TEXT, "deletedAt" TIMESTAMP(3), "reconciliationCompletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("shop", "collectionId")
);
CREATE INDEX "CollectionTombstone_shop_tombstoneMutationSequence_idx" ON "CollectionTombstone"("shop", "tombstoneMutationSequence");
