-- AlterTable
ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "executionOwnerId" TEXT;
ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "executionLeaseUntil" TIMESTAMP(3);
ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "executionHeartbeatAt" TIMESTAMP(3);
