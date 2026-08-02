-- AlterEnum
ALTER TYPE "StoreInstallationStatus" ADD VALUE IF NOT EXISTS 'INSTALLING';
ALTER TYPE "StoreInstallationStatus" ADD VALUE IF NOT EXISTS 'INSTALL_FAILED';

-- AlterTable
ALTER TABLE "Store"
  ADD COLUMN IF NOT EXISTS "installationExecutionId" TEXT,
  ADD COLUMN IF NOT EXISTS "installationStage" TEXT,
  ADD COLUMN IF NOT EXISTS "installationLeaseUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "installationAttemptCount" INTEGER NOT NULL DEFAULT 0;
