-- Neon/PostgreSQL: this migration uses CONCURRENTLY and must not be wrapped in a transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OutboxEventStatus') THEN
    CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'DISPATCHING', 'DISPATCHED', 'DEAD_LETTER');
  END IF;
END $$;

ALTER TABLE "OutboxEvent"
  ADD COLUMN IF NOT EXISTS "statusNormalized" "OutboxEventStatus",
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT;

UPDATE "OutboxEvent"
SET "statusNormalized" = CASE UPPER("status")
    WHEN 'DISPATCHING' THEN 'DISPATCHING'::"OutboxEventStatus"
    WHEN 'DISPATCHED' THEN 'DISPATCHED'::"OutboxEventStatus"
    WHEN 'FAILED' THEN 'DEAD_LETTER'::"OutboxEventStatus"
    WHEN 'DEAD_LETTER' THEN 'DEAD_LETTER'::"OutboxEventStatus"
    ELSE 'PENDING'::"OutboxEventStatus"
  END,
  "nextAttemptAt" = COALESCE("nextAttemptAt", "createdAt", NOW());

ALTER TABLE "OutboxEvent"
  ALTER COLUMN "statusNormalized" SET DEFAULT 'PENDING',
  ALTER COLUMN "statusNormalized" SET NOT NULL,
  ALTER COLUMN "nextAttemptAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "nextAttemptAt" SET NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "OutboxEvent_shop_eventIdentity_key"
  ON "OutboxEvent" ("shop", "eventIdentity");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "OutboxEvent_statusNormalized_nextAttemptAt_createdAt_idx"
  ON "OutboxEvent" ("statusNormalized", "nextAttemptAt", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "OutboxEvent_shop_statusNormalized_nextAttemptAt_idx"
  ON "OutboxEvent" ("shop", "statusNormalized", "nextAttemptAt");
DROP INDEX CONCURRENTLY IF EXISTS "OutboxEvent_eventIdentity_key";
DROP INDEX CONCURRENTLY IF EXISTS "OutboxEvent_status_createdAt_idx";

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "EditHistory_shop_id_key" ON "EditHistory" ("shop", "id");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "EditHistory_shop_executionIdentity_key" ON "EditHistory" ("shop", "executionIdentity");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UndoOperation_shop_id_key" ON "UndoOperation" ("shop", "id");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UndoOperation_shop_executionIdentity_key" ON "UndoOperation" ("shop", "executionIdentity");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UndoCommand_shop_commandHash_key" ON "UndoCommand" ("shop", "commandHash");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "RecurringEditRun_shop_executionKey_key" ON "RecurringEditRun" ("shop", "executionKey");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ScheduledExportRun_shop_executionKey_key" ON "ScheduledExportRun" ("shop", "executionKey");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "AutomaticProductRuleRun_shop_executionKey_key" ON "AutomaticProductRuleRun" ("shop", "executionKey");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "TargetSnapshotSet_shop_id_key" ON "TargetSnapshotSet" ("shop", "id");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "UndoOperation" u
    JOIN "EditHistory" e ON e."id" = u."sourceEditHistoryId"
    WHERE e."shop" <> u."shop"
  ) THEN RAISE EXCEPTION 'UndoOperation contains cross-shop EditHistory references'; END IF;

  IF EXISTS (
    SELECT 1 FROM "UndoCommand" c
    JOIN "UndoOperation" u ON u."id" = c."undoOperationId"
    WHERE u."shop" <> c."shop"
  ) THEN RAISE EXCEPTION 'UndoCommand contains cross-shop UndoOperation references'; END IF;

  IF EXISTS (
    SELECT 1 FROM "TargetSnapshotItem" i
    JOIN "TargetSnapshotSet" s ON s."id" = i."snapshotSetId"
    WHERE s."shop" <> i."shop"
       OR s."operationId" <> i."operationId"
       OR s."mirrorBatchId" <> i."mirrorBatchId"
  ) THEN RAISE EXCEPTION 'TargetSnapshotItem contains parent metadata mismatches'; END IF;
END $$;

ALTER TABLE "UndoOperation" DROP CONSTRAINT IF EXISTS "UndoOperation_sourceEditHistoryId_fkey";
ALTER TABLE "UndoOperation" ADD CONSTRAINT "UndoOperation_shop_sourceEditHistoryId_fkey"
  FOREIGN KEY ("shop", "sourceEditHistoryId") REFERENCES "EditHistory" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UndoOperation" VALIDATE CONSTRAINT "UndoOperation_shop_sourceEditHistoryId_fkey";

ALTER TABLE "UndoCommand" DROP CONSTRAINT IF EXISTS "UndoCommand_undoOperationId_fkey";
ALTER TABLE "UndoCommand" ADD CONSTRAINT "UndoCommand_shop_undoOperationId_fkey"
  FOREIGN KEY ("shop", "undoOperationId") REFERENCES "UndoOperation" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UndoCommand" VALIDATE CONSTRAINT "UndoCommand_shop_undoOperationId_fkey";

ALTER TABLE "TargetSnapshotItem" DROP CONSTRAINT IF EXISTS "TargetSnapshotItem_snapshotSetId_fkey";
ALTER TABLE "TargetSnapshotItem" ADD CONSTRAINT "TargetSnapshotItem_shop_snapshotSetId_fkey"
  FOREIGN KEY ("shop", "snapshotSetId") REFERENCES "TargetSnapshotSet" ("shop", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TargetSnapshotItem" VALIDATE CONSTRAINT "TargetSnapshotItem_shop_snapshotSetId_fkey";

DROP INDEX CONCURRENTLY IF EXISTS "EditHistory_executionIdentity_key";
DROP INDEX CONCURRENTLY IF EXISTS "EditHistory_shop_executionIdentity_idx";
DROP INDEX CONCURRENTLY IF EXISTS "UndoOperation_executionIdentity_key";
DROP INDEX CONCURRENTLY IF EXISTS "UndoCommand_commandHash_key";
DROP INDEX CONCURRENTLY IF EXISTS "RecurringEditRun_executionKey_key";
DROP INDEX CONCURRENTLY IF EXISTS "ScheduledExportRun_executionKey_key";
DROP INDEX CONCURRENTLY IF EXISTS "AutomaticProductRuleRun_executionKey_key";

DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_googleShoppingCustomLabel0_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_googleShoppingCustomLabel1_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_googleShoppingCustomLabel2_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_googleShoppingCustomLabel3_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_googleShoppingCustomLabel4_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_categoryFabric_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_categoryFit_idx";
DROP INDEX CONCURRENTLY IF EXISTS "Product_shop_mirrorBatchId_categoryWaistRise_idx";
