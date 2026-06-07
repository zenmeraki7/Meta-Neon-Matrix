ALTER TABLE "EditHistory"
  ADD COLUMN IF NOT EXISTS "verificationCursor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "verifiedItems" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failedVerifications" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "failedItems" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "EditHistory_executionState_updatedAt_idx"
  ON "EditHistory"("executionState", "updatedAt");
