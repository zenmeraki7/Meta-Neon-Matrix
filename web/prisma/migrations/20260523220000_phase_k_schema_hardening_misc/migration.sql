ALTER TABLE "shopify_sessions"
  ALTER COLUMN "accessToken" TYPE TEXT,
  ALTER COLUMN "onlineAccessInfo" TYPE TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

ALTER TABLE "Location"
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "legacy" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS "ProductMediaMirror" (
  "shop" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "mediaId" TEXT NOT NULL,
  "mirrorBatchId" TEXT NOT NULL,
  "mediaType" TEXT,
  "url" TEXT,
  "alt" TEXT,
  "position" INTEGER,
  "status" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductMediaMirror_pkey" PRIMARY KEY ("shop","productId","mediaId","mirrorBatchId")
);

CREATE INDEX IF NOT EXISTS "ProductMediaMirror_shop_mirrorBatchId_productId_position_idx"
  ON "ProductMediaMirror"("shop","mirrorBatchId","productId","position");

ALTER TABLE "SpreadsheetFile"
  ADD COLUMN IF NOT EXISTS "operationType" TEXT,
  ADD COLUMN IF NOT EXISTS "operationId" TEXT,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'UPLOADED',
  ADD COLUMN IF NOT EXISTS "originalFilename" TEXT,
  ADD COLUMN IF NOT EXISTS "storageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "checksum" TEXT,
  ADD COLUMN IF NOT EXISTS "rowParseErrorCount" INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "validatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SpreadsheetFile_shop_editHistoryId_idx"
  ON "SpreadsheetFile"("shop","editHistoryId");

CREATE INDEX IF NOT EXISTS "SpreadsheetFile_shop_operationType_operationId_idx"
  ON "SpreadsheetFile"("shop","operationType","operationId");

ALTER TABLE "ExportHistory"
  ADD COLUMN IF NOT EXISTS "fileUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "storageKey" TEXT,
  ADD COLUMN IF NOT EXISTS "checksum" TEXT,
  ADD COLUMN IF NOT EXISTS "sizeBytes" BIGINT;

ALTER TABLE "ChangeRecord"
  ALTER COLUMN "title" DROP NOT NULL;

ALTER TABLE "FilterTrack"
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "userId" TEXT,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "FilterTrack_shop_createdAt_idx"
  ON "FilterTrack"("shop","createdAt");

CREATE INDEX IF NOT EXISTS "FilterTrack_expiresAt_idx"
  ON "FilterTrack"("expiresAt");

ALTER TABLE "ErrorLog"
  ADD COLUMN IF NOT EXISTS "requestId" TEXT,
  ADD COLUMN IF NOT EXISTS "method" TEXT,
  ADD COLUMN IF NOT EXISTS "path" TEXT,
  ADD COLUMN IF NOT EXISTS "statusCode" INTEGER,
  ADD COLUMN IF NOT EXISTS "safeContext" JSONB;

DROP INDEX IF EXISTS "ExportHistory_scheduledTask_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ExportHistory_shop_scheduledTask_key"
  ON "ExportHistory"("shop","scheduledTask");
