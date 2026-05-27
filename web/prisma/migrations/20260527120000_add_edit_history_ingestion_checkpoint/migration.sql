-- Phase 4: dedicated ingestion checkpoint table for bulk edit result ingestion
CREATE TABLE "EditHistoryIngestionCheckpoint" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "historyId" TEXT NOT NULL,
  "ingestionRunId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "rowOffset" INTEGER NOT NULL DEFAULT 0,
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "successCount" INTEGER NOT NULL DEFAULT 0,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "unmappedRowCount" INTEGER NOT NULL DEFAULT 0,
  "malformedRowCount" INTEGER NOT NULL DEFAULT 0,
  "rollingChecksum" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EditHistoryIngestionCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EditHistoryIngestionCheckpoint_shop_historyId_ingestionRunId_key"
ON "EditHistoryIngestionCheckpoint"("shop", "historyId", "ingestionRunId");

CREATE INDEX "EditHistoryIngestionCheckpoint_shop_historyId_status_updatedAt_idx"
ON "EditHistoryIngestionCheckpoint"("shop", "historyId", "status", "updatedAt");

CREATE INDEX "EditHistoryIngestionCheckpoint_shop_historyId_updatedAt_idx"
ON "EditHistoryIngestionCheckpoint"("shop", "historyId", "updatedAt");

ALTER TABLE "EditHistoryIngestionCheckpoint"
ADD CONSTRAINT "EditHistoryIngestionCheckpoint_historyId_fkey"
FOREIGN KEY ("historyId") REFERENCES "EditHistory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
