ALTER TABLE "Store"
ADD COLUMN IF NOT EXISTS "productSyncStartedAt" TIMESTAMP(3);

ALTER TABLE "Store"
ADD COLUMN IF NOT EXISTS "productSyncRecoveryRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "store_product_sync_started_at_idx"
ON "Store"("productSyncStartedAt");

CREATE INDEX IF NOT EXISTS "store_product_sync_recovery_required_idx"
ON "Store"("productSyncRecoveryRequired");
