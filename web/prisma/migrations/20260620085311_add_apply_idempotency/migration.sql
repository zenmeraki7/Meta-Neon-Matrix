/*
  Warnings:

  - You are about to drop the `BulkEditItem` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "BulkEditItem";

-- CreateTable
CREATE TABLE "BulkApplyRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "bulkJobId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkApplyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkApplyItem" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "bulkJobId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkApplyItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkApplyRequest_shop_bulkJobId_idx" ON "BulkApplyRequest"("shop", "bulkJobId");

-- CreateIndex
CREATE UNIQUE INDEX "BulkApplyRequest_shop_bulkJobId_idempotencyKey_key" ON "BulkApplyRequest"("shop", "bulkJobId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BulkApplyItem_shop_status_idx" ON "BulkApplyItem"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BulkApplyItem_shop_bulkJobId_productId_key" ON "BulkApplyItem"("shop", "bulkJobId", "productId");
