-- AlterTable TargetSnapshotItem add execution claim fields
ALTER TABLE "TargetSnapshotItem"
  ADD COLUMN IF NOT EXISTS "executionOwnerId" TEXT,
  ADD COLUMN IF NOT EXISTS "externalAttemptId" TEXT,
  ADD COLUMN IF NOT EXISTS "executionLeaseAt" TIMESTAMP(3);
