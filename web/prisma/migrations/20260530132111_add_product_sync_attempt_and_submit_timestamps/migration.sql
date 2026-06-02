ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "lastProductSyncAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastProductSyncSubmittedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Store_lastProductSyncAttemptAt_idx" ON "Store"("lastProductSyncAttemptAt");
CREATE INDEX IF NOT EXISTS "Store_lastProductSyncSubmittedAt_idx" ON "Store"("lastProductSyncSubmittedAt");
