ALTER TABLE "ChangeRecord"
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "retryable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "writingStartedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "appliedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_status_retryable_idx"
  ON "ChangeRecord"("shop", "status", "retryable");

CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_status_writingStartedAt_idx"
  ON "ChangeRecord"("shop", "status", "writingStartedAt");

UPDATE "ChangeRecord"
SET
  "appliedAt" = COALESCE("appliedAt", "updatedAt"),
  "retryable" = false
WHERE "status" IN ('SUCCESS', 'VERIFIED', 'APPLIED');

UPDATE "ChangeRecord"
SET
  "retryable" = false
WHERE "status" IN ('FAILED', 'failed')
  AND "failureCode" IS NOT NULL;
