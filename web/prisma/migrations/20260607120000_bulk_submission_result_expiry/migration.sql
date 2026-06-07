ALTER TABLE "BulkSubmission"
ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
ADD COLUMN IF NOT EXISTS "resultUrl" TEXT,
ADD COLUMN IF NOT EXISTS "resultUrlExpiresAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "lastError" TEXT;

CREATE INDEX IF NOT EXISTS "BulkSubmission_shop_processedAt_resultUrlExpiresAt_idx"
ON "BulkSubmission"("shop", "processedAt", "resultUrlExpiresAt");
