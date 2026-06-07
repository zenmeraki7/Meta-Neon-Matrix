ALTER TABLE "EditHistory"
  ADD COLUMN IF NOT EXISTS "sourceEditHistoryId" TEXT;

ALTER TABLE "UndoOperation"
  ADD COLUMN IF NOT EXISTS "undoEditHistoryId" TEXT;

CREATE INDEX IF NOT EXISTS "EditHistory_shop_sourceEditHistoryId_idx"
  ON "EditHistory"("shop", "sourceEditHistoryId");

CREATE UNIQUE INDEX IF NOT EXISTS "UndoOperation_undoEditHistoryId_key"
  ON "UndoOperation"("undoEditHistoryId");

CREATE INDEX IF NOT EXISTS "UndoOperation_shop_undoEditHistoryId_idx"
  ON "UndoOperation"("shop", "undoEditHistoryId");

ALTER TABLE "EditHistory"
  ADD CONSTRAINT "EditHistory_sourceEditHistoryId_fkey"
  FOREIGN KEY ("sourceEditHistoryId") REFERENCES "EditHistory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UndoOperation"
  ADD CONSTRAINT "UndoOperation_undoEditHistoryId_fkey"
  FOREIGN KEY ("undoEditHistoryId") REFERENCES "EditHistory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
