-- Phase E: MirrorBatch model + lifecycle foundation

-- Create enums (idempotent)
DO $$ BEGIN
  CREATE TYPE "MirrorResourceType" AS ENUM ('PRODUCT_CATALOG', 'COLLECTION_CATALOG');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "MirrorBatchStatus" AS ENUM (
    'SYNC_REQUESTED',
    'BULK_OPERATION_STARTED',
    'BULK_OPERATION_COMPLETED',
    'FILE_DOWNLOADING',
    'FILE_DOWNLOADED',
    'INGESTING_TO_STAGING_BATCH',
    'VALIDATING_BATCH',
    'ACTIVATING_BATCH',
    'ACTIVE',
    'FAILED',
    'RETIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "MirrorBatch" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "resourceType" "MirrorResourceType" NOT NULL DEFAULT 'PRODUCT_CATALOG',
  "status" "MirrorBatchStatus" NOT NULL DEFAULT 'SYNC_REQUESTED',
  "syncHistoryId" TEXT,
  "bulkOperationId" TEXT,
  "expectedProducts" INTEGER,
  "actualProducts" INTEGER,
  "expectedVariants" INTEGER,
  "actualVariants" INTEGER,
  "expectedCollections" INTEGER,
  "actualCollections" INTEGER,
  "expectedMetafields" INTEGER,
  "actualMetafields" INTEGER,
  "activatedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MirrorBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MirrorBatch_shop_id_key" ON "MirrorBatch"("shop", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "MirrorBatch_syncHistoryId_key" ON "MirrorBatch"("syncHistoryId");
CREATE INDEX IF NOT EXISTS "MirrorBatch_shop_resourceType_status_idx" ON "MirrorBatch"("shop", "resourceType", "status");
CREATE INDEX IF NOT EXISTS "MirrorBatch_shop_status_createdAt_idx" ON "MirrorBatch"("shop", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "MirrorBatch_shop_bulkOperationId_idx" ON "MirrorBatch"("shop", "bulkOperationId");

DO $$ BEGIN
  ALTER TABLE "MirrorBatch"
  ADD CONSTRAINT "MirrorBatch_shop_fkey"
  FOREIGN KEY ("shop") REFERENCES "Store"("shopUrl") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MirrorBatch"
  ADD CONSTRAINT "MirrorBatch_syncHistoryId_fkey"
  FOREIGN KEY ("syncHistoryId") REFERENCES "SyncHistory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Backfill from existing SyncHistory product/collection runs
INSERT INTO "MirrorBatch" (
  "id",
  "shop",
  "resourceType",
  "status",
  "syncHistoryId",
  "bulkOperationId",
  "actualProducts",
  "failureReason",
  "createdAt",
  "updatedAt",
  "activatedAt",
  "failedAt"
)
SELECT
  sh."syncBatchId",
  sh."shop",
  CASE
    WHEN sh."operationType" = 'Collection' THEN 'COLLECTION_CATALOG'::"MirrorResourceType"
    ELSE 'PRODUCT_CATALOG'::"MirrorResourceType"
  END,
  CASE
    WHEN sh."status" = 'completed' THEN 'ACTIVE'::"MirrorBatchStatus"
    WHEN sh."status" = 'failed' THEN 'FAILED'::"MirrorBatchStatus"
    ELSE 'BULK_OPERATION_STARTED'::"MirrorBatchStatus"
  END,
  sh."id",
  sh."bulkOperationId",
  CASE
    WHEN sh."operationType" = 'Product' THEN sh."recordCount"
    ELSE NULL
  END,
  sh."errorMessage",
  sh."createdAt",
  sh."updatedAt",
  CASE WHEN sh."status" = 'completed' THEN COALESCE(sh."completedAt", sh."updatedAt") ELSE NULL END,
  CASE WHEN sh."status" = 'failed' THEN sh."updatedAt" ELSE NULL END
FROM "SyncHistory" sh
WHERE sh."syncBatchId" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
