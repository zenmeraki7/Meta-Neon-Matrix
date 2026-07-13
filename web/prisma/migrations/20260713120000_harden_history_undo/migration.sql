ALTER TABLE "UndoOperation"
  ADD COLUMN "restoredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skippedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "conflictedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "errorCode" TEXT,
  ADD COLUMN "errorMessage" TEXT,
  ADD COLUMN "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "startedAt" TIMESTAMP(3),
  ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE TABLE "UndoCommand" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "undoOperationId" TEXT NOT NULL,
  "sourceEditHistoryId" TEXT NOT NULL,
  "commandVersion" INTEGER NOT NULL DEFAULT 1,
  "commandHash" TEXT NOT NULL,
  "commandJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UndoCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UndoCommand_undoOperationId_key" ON "UndoCommand"("undoOperationId");
CREATE UNIQUE INDEX "UndoCommand_commandHash_key" ON "UndoCommand"("commandHash");
CREATE INDEX "UndoCommand_shop_sourceEditHistoryId_idx" ON "UndoCommand"("shop", "sourceEditHistoryId");

ALTER TABLE "UndoCommand"
  ADD CONSTRAINT "UndoCommand_undoOperationId_fkey"
  FOREIGN KEY ("undoOperationId") REFERENCES "UndoOperation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutboxEvent"
  ADD COLUMN "eventIdentity" TEXT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastErrorCode" TEXT,
  ADD COLUMN "lastErrorAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "OutboxEvent_eventIdentity_key" ON "OutboxEvent"("eventIdentity");
