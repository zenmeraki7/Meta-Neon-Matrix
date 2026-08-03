-- AlterTable
ALTER TABLE "RecurringEditRun"
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "executionOwnerId" TEXT,
  ADD COLUMN IF NOT EXISTS "executionLeaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "executionFence" BIGINT NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "RecurringEditRun_retry_idx"
ON "RecurringEditRun" ("nextAttemptAt")
WHERE "status" = 'RETRY_WAIT';

-- AlterTable: ScheduledExportRun already exists from the initial migration.
ALTER TABLE "ScheduledExportRun"
  ADD COLUMN IF NOT EXISTS "retryGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastDeferralReason" TEXT,
  ADD COLUMN IF NOT EXISTS "executionOwnerId" TEXT,
  ADD COLUMN IF NOT EXISTS "executionLeaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "executionFence" BIGINT NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledExportRun_shop_executionKey_key"
ON "ScheduledExportRun" ("shop", "executionKey");

-- CreateTable
CREATE TABLE IF NOT EXISTS "RecurringEditMutation" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringEditMutation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RecurringEditMutation_shop_key_uq"
ON "RecurringEditMutation" ("shop", "idempotencyKey");
