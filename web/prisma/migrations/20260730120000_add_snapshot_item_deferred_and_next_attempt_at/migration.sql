-- AlterEnum
ALTER TYPE "TargetSnapshotItemExecutionStatus" ADD VALUE IF NOT EXISTS 'DEFERRED';
ALTER TYPE "TargetSnapshotItemExecutionStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable
ALTER TABLE "TargetSnapshotItem" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);
