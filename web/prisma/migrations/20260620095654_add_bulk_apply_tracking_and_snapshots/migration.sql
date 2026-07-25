-- AlterTable
ALTER TABLE "BulkApplyItem" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BulkApplyRequest" ADD COLUMN     "appliedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelledCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "skippedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "totalCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "ProductApplySnapshot" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "bulkJobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductApplySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductApplySnapshot_shop_bulkJobId_idx" ON "ProductApplySnapshot"("shop", "bulkJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductApplySnapshot_shop_bulkJobId_productId_key" ON "ProductApplySnapshot"("shop", "bulkJobId", "productId");

-- CreateIndex
CREATE INDEX "BulkApplyItem_shop_bulkJobId_idx" ON "BulkApplyItem"("shop", "bulkJobId");

-- CreateIndex
CREATE INDEX "BulkApplyRequest_shop_status_idx" ON "BulkApplyRequest"("shop", "status");
