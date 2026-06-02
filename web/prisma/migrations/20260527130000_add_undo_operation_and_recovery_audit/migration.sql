CREATE TABLE "UndoOperation" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "sourceEditHistoryId" TEXT NOT NULL,
  "executionIdentity" TEXT NOT NULL,
  "idempotencyKeyHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "state" TEXT NOT NULL DEFAULT 'queued',
  "bulkOperationId" TEXT,
  "processedCount" INTEGER NOT NULL DEFAULT 0,
  "totalEligibleCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UndoOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UndoOperation_executionIdentity_key" ON "UndoOperation"("executionIdentity");
CREATE UNIQUE INDEX "UndoOperation_shop_sourceEditHistoryId_key" ON "UndoOperation"("shop", "sourceEditHistoryId");
CREATE INDEX "UndoOperation_shop_status_updatedAt_idx" ON "UndoOperation"("shop", "status", "updatedAt");

ALTER TABLE "UndoOperation"
ADD CONSTRAINT "UndoOperation_sourceEditHistoryId_fkey"
FOREIGN KEY ("sourceEditHistoryId") REFERENCES "EditHistory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UndoOperationConflictChunk" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "undoOperationId" TEXT NOT NULL,
  "chunkType" TEXT NOT NULL,
  "chunkIndex" INTEGER NOT NULL,
  "totalItems" INTEGER NOT NULL DEFAULT 0,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UndoOperationConflictChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UndoOperationConflictChunk_shop_undoOperationId_chunkType_chunkInd_key"
ON "UndoOperationConflictChunk"("shop", "undoOperationId", "chunkType", "chunkIndex");
CREATE INDEX "UndoOperationConflictChunk_shop_undoOperationId_chunkType_chunkIn_idx"
ON "UndoOperationConflictChunk"("shop", "undoOperationId", "chunkType", "chunkIndex");

ALTER TABLE "UndoOperationConflictChunk"
ADD CONSTRAINT "UndoOperationConflictChunk_undoOperationId_fkey"
FOREIGN KEY ("undoOperationId") REFERENCES "UndoOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BulkEditRecoveryAudit" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "historyId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorType" TEXT,
  "actorId" TEXT,
  "actorEmail" TEXT,
  "result" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BulkEditRecoveryAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BulkEditRecoveryAudit_shop_historyId_createdAt_idx" ON "BulkEditRecoveryAudit"("shop", "historyId", "createdAt");

ALTER TABLE "BulkEditRecoveryAudit"
ADD CONSTRAINT "BulkEditRecoveryAudit_historyId_fkey"
FOREIGN KEY ("historyId") REFERENCES "EditHistory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
