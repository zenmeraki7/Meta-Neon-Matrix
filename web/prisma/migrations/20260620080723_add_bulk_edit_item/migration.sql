-- CreateTable
CREATE TABLE "BulkEditItem" (
    "id" TEXT NOT NULL,
    "historyId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "shopifyMetafieldId" TEXT,
    "failureReason" TEXT,
    "failureMessage" TEXT,
    "userErrors" JSONB,
    "retryAfterMs" INTEGER,
    "lastAttemptedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "deferredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkEditItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkEditItem_shop_historyId_idx" ON "BulkEditItem"("shop", "historyId");

-- CreateIndex
CREATE INDEX "BulkEditItem_shop_status_idx" ON "BulkEditItem"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BulkEditItem_historyId_ownerId_namespace_key_key" ON "BulkEditItem"("historyId", "ownerId", "namespace", "key");
