ALTER TABLE "Store"
ADD COLUMN "installationGeneration" TEXT,
ADD COLUMN "installationStatus" TEXT NOT NULL DEFAULT 'complete',
ADD COLUMN "installationProcessingStartedAt" TIMESTAMP(3),
ADD COLUMN "installationSetupCompletedAt" TIMESTAMP(3);

CREATE INDEX "Store_installationGeneration_idx" ON "Store"("installationGeneration");
CREATE INDEX "Store_installationStatus_idx" ON "Store"("installationStatus");
CREATE INDEX "Store_installationProcessingStartedAt_idx" ON "Store"("installationProcessingStartedAt");

ALTER TABLE "Store" ALTER COLUMN "installationStatus" SET DEFAULT 'pending';
