-- Existing UndoOperation rows remain historical. They cannot be replayed through
-- the trusted path because their exact before/written evidence was not frozen.
CREATE TYPE "UndoOperationTrustStatus" AS ENUM ('TRUSTED', 'LEGACY_UNTRUSTED');
CREATE TYPE "UndoItemOutcome" AS ENUM (
  'ELIGIBLE',
  'CONFLICT',
  'APPROVED',
  'SUBMITTED',
  'RESTORED',
  'FAILED',
  'SKIPPED',
  'MANUAL_REVIEW'
);

ALTER TABLE "UndoOperation"
  ADD COLUMN "undoItemSetRevision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "serializerVersion" TEXT,
  ADD COLUMN "trustStatus" "UndoOperationTrustStatus" NOT NULL DEFAULT 'LEGACY_UNTRUSTED',
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedByActorId" TEXT;

CREATE TABLE "UndoItem" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "undoOperationId" TEXT NOT NULL,
  "targetIdentity" TEXT NOT NULL,
  "targetResourceType" "TargetSnapshotTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "fieldPath" TEXT NOT NULL,
  "targetContext" JSONB NOT NULL,
  "beforeValue" JSONB NOT NULL,
  "beforeValueHash" TEXT NOT NULL,
  "writtenValueHash" TEXT NOT NULL,
  "observedCurrentValueHash" TEXT,
  "serializerVersion" TEXT NOT NULL,
  "outcome" "UndoItemOutcome" NOT NULL DEFAULT 'ELIGIBLE',
  "failureCode" TEXT,
  "failureMessage" TEXT,
  "observedAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "restoredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UndoItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UndoItem_shop_id_key"
  ON "UndoItem"("shop", "id");
CREATE UNIQUE INDEX "UndoItem_shop_operation_target_field_key"
  ON "UndoItem"("shop", "undoOperationId", "targetIdentity", "fieldPath");
CREATE INDEX "UndoItem_shop_operation_outcome_idx"
  ON "UndoItem"("shop", "undoOperationId", "outcome");
CREATE INDEX "UndoItem_shop_resource_target_idx"
  ON "UndoItem"("shop", "targetResourceType", "targetId");
CREATE INDEX "UndoItem_shop_productId_idx" ON "UndoItem"("shop", "productId");
CREATE INDEX "UndoItem_shop_variantId_idx" ON "UndoItem"("shop", "variantId");

ALTER TABLE "UndoItem"
  ADD CONSTRAINT "UndoItem_shop_undoOperationId_fkey"
  FOREIGN KEY ("shop", "undoOperationId")
  REFERENCES "UndoOperation"("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A client may reuse an idempotency key across old one-per-history rows. Retain
-- the earliest hash and make later historical duplicates non-claimable.
WITH duplicate_keys AS (
  SELECT "id", "shop", ROW_NUMBER() OVER (
    PARTITION BY "shop", "idempotencyKeyHash"
    ORDER BY "createdAt", "id"
  ) AS ordinal
  FROM "UndoOperation"
  WHERE "idempotencyKeyHash" IS NOT NULL
)
UPDATE "UndoOperation" AS operation
SET "idempotencyKeyHash" = NULL
FROM duplicate_keys
WHERE operation."id" = duplicate_keys."id"
  AND operation."shop" = duplicate_keys."shop"
  AND duplicate_keys.ordinal > 1;

DROP INDEX IF EXISTS "UndoOperation_shop_sourceEditHistoryId_key";
CREATE UNIQUE INDEX "UndoOperation_shop_idempotencyKeyHash_key"
  ON "UndoOperation"("shop", "idempotencyKeyHash");
CREATE INDEX "UndoOperation_shop_source_history_created_idx"
  ON "UndoOperation"("shop", "sourceEditHistoryId", "createdAt");

-- Protect the immutable authority even from accidental repository updates.
CREATE OR REPLACE FUNCTION reject_undo_item_authority_update()
RETURNS trigger AS $$
BEGIN
  IF NEW."shop" IS DISTINCT FROM OLD."shop"
     OR NEW."undoOperationId" IS DISTINCT FROM OLD."undoOperationId"
     OR NEW."targetIdentity" IS DISTINCT FROM OLD."targetIdentity"
     OR NEW."targetResourceType" IS DISTINCT FROM OLD."targetResourceType"
     OR NEW."targetId" IS DISTINCT FROM OLD."targetId"
     OR NEW."productId" IS DISTINCT FROM OLD."productId"
     OR NEW."variantId" IS DISTINCT FROM OLD."variantId"
     OR NEW."fieldPath" IS DISTINCT FROM OLD."fieldPath"
     OR NEW."targetContext" IS DISTINCT FROM OLD."targetContext"
     OR NEW."beforeValue" IS DISTINCT FROM OLD."beforeValue"
     OR NEW."beforeValueHash" IS DISTINCT FROM OLD."beforeValueHash"
     OR NEW."writtenValueHash" IS DISTINCT FROM OLD."writtenValueHash"
     OR NEW."serializerVersion" IS DISTINCT FROM OLD."serializerVersion"
     OR (
       OLD."observedCurrentValueHash" IS NOT NULL
       AND NEW."observedCurrentValueHash" IS DISTINCT FROM OLD."observedCurrentValueHash"
     )
     OR (OLD."observedAt" IS NOT NULL AND NEW."observedAt" IS DISTINCT FROM OLD."observedAt")
  THEN
    RAISE EXCEPTION 'UndoItem authority is immutable';
  END IF;
  IF NEW."outcome" IS DISTINCT FROM OLD."outcome" AND NOT (
    (OLD."outcome" = 'ELIGIBLE' AND NEW."outcome" IN ('APPROVED', 'CONFLICT', 'SKIPPED', 'MANUAL_REVIEW'))
    OR (OLD."outcome" = 'APPROVED' AND NEW."outcome" IN ('CONFLICT', 'SUBMITTED', 'SKIPPED', 'MANUAL_REVIEW'))
    OR (OLD."outcome" = 'SUBMITTED' AND NEW."outcome" IN ('RESTORED', 'FAILED', 'MANUAL_REVIEW'))
  ) THEN
    RAISE EXCEPTION 'Invalid UndoItem outcome transition: % -> %', OLD."outcome", NEW."outcome";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UndoItem_reject_authority_update"
BEFORE UPDATE ON "UndoItem"
FOR EACH ROW EXECUTE FUNCTION reject_undo_item_authority_update();

CREATE OR REPLACE FUNCTION reject_undo_command_authority_update()
RETURNS trigger AS $$
BEGIN
  IF NEW."shop" IS DISTINCT FROM OLD."shop"
     OR NEW."undoOperationId" IS DISTINCT FROM OLD."undoOperationId"
     OR NEW."sourceEditHistoryId" IS DISTINCT FROM OLD."sourceEditHistoryId"
     OR NEW."commandVersion" IS DISTINCT FROM OLD."commandVersion"
     OR NEW."commandHash" IS DISTINCT FROM OLD."commandHash"
     OR NEW."commandJson" IS DISTINCT FROM OLD."commandJson"
  THEN
    RAISE EXCEPTION 'UndoCommand is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UndoCommand_reject_authority_update"
BEFORE UPDATE ON "UndoCommand"
FOR EACH ROW EXECUTE FUNCTION reject_undo_command_authority_update();

-- The ADD COLUMN default marked pre-migration rows as untrusted. New rows must
-- opt into the trusted path and supply immutable items in the same transaction.
ALTER TABLE "UndoOperation"
  ALTER COLUMN "trustStatus" SET DEFAULT 'TRUSTED';

CREATE OR REPLACE FUNCTION require_trusted_undo_evidence()
RETURNS trigger AS $$
BEGIN
  IF NEW."trustStatus" = 'TRUSTED'
     AND (
       NEW."serializerVersion" IS NULL
       OR NEW."approvedAt" IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM "UndoItem" item
         WHERE item."shop" = NEW."shop"
           AND item."undoOperationId" = NEW."id"
       )
       OR NOT EXISTS (
         SELECT 1 FROM "UndoCommand" command
         WHERE command."shop" = NEW."shop"
           AND command."undoOperationId" = NEW."id"
       )
     )
  THEN
    RAISE EXCEPTION 'Trusted undo operation requires approval, serializer, items, and command';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "UndoOperation_require_trusted_evidence"
AFTER INSERT OR UPDATE OF "trustStatus", "serializerVersion", "approvedAt"
ON "UndoOperation"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION require_trusted_undo_evidence();
