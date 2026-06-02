ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "productSyncStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "productSyncRecoveryRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "Store_productSyncStartedAt_idx" ON "Store"("productSyncStartedAt");
CREATE INDEX IF NOT EXISTS "Store_productSyncRecoveryRequired_idx" ON "Store"("productSyncRecoveryRequired");
