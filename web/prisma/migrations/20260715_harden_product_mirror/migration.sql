ALTER TYPE "MirrorBatchStatus" ADD VALUE IF NOT EXISTS 'REPLAYING_MUTATIONS';
ALTER TYPE "MirrorBatchStatus" ADD VALUE IF NOT EXISTS 'FINALIZED';
ALTER TYPE "MirrorBatchStatus" ADD VALUE IF NOT EXISTS 'RETIRED';
ALTER TYPE "MirrorBatchStatus" ADD VALUE IF NOT EXISTS 'CLEANING';
ALTER TYPE "MirrorBatchStatus" ADD VALUE IF NOT EXISTS 'CLEANED';

ALTER TABLE "MirrorBatch"
  ADD COLUMN IF NOT EXISTS "expectedActiveBatchId" TEXT,
  ADD COLUMN IF NOT EXISTS "syncStartSequence" BIGINT,
  ADD COLUMN IF NOT EXISTS "finalizedSequence" BIGINT,
  ADD COLUMN IF NOT EXISTS "finalizedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cleanupStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cleanedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "MirrorBatch_shop_syncStartSequence_idx"
  ON "MirrorBatch"("shop", "syncStartSequence");

CREATE INDEX IF NOT EXISTS "MirrorBatch_shop_finalizedSequence_idx"
  ON "MirrorBatch"("shop", "finalizedSequence");

CREATE INDEX IF NOT EXISTS "MirrorBatch_shop_status_retiredAt_idx"
  ON "MirrorBatch"("shop", "status", "retiredAt");

CREATE TABLE IF NOT EXISTS "MirrorMutationJournal" (
  "sequence" BIGSERIAL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "productId" TEXT,
  "mutationType" TEXT NOT NULL,
  "payload" JSONB,
  "sourceEventAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "MirrorMutationJournal_shop_sequence_idx"
  ON "MirrorMutationJournal"("shop", "sequence");

CREATE INDEX IF NOT EXISTS "MirrorMutationJournal_shop_productId_sequence_idx"
  ON "MirrorMutationJournal"("shop", "productId", "sequence");

CREATE INDEX IF NOT EXISTS "MirrorMutationJournal_shop_entityType_entityId_sequence_idx"
  ON "MirrorMutationJournal"("shop", "entityType", "entityId", "sequence");

ALTER TABLE "ProductTombstone"
  ADD COLUMN IF NOT EXISTS "mutationSequence" BIGINT;

UPDATE "ProductTombstone"
SET "mutationSequence" = 0
WHERE "mutationSequence" IS NULL;

ALTER TABLE "ProductTombstone"
  ALTER COLUMN "mutationSequence" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "ProductTombstone_shop_mutationSequence_idx"
  ON "ProductTombstone"("shop", "mutationSequence");

ALTER TABLE "MirrorReconcileSignal"
  ADD COLUMN IF NOT EXISTS "mutationSequence" BIGINT;

CREATE INDEX IF NOT EXISTS "MirrorReconcileSignal_shop_mutationSequence_idx"
  ON "MirrorReconcileSignal"("shop", "mutationSequence");
