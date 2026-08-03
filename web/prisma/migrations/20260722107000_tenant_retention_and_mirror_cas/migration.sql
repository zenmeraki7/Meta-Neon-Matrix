-- Tenant, retention, export-resume, and mirror-promotion hardening for Neon.
-- Statements are kept transaction-safe for Prisma shadow-database replay.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "MirrorBatch"
    WHERE "status" = 'ACTIVE' AND "resourceType" = 'PRODUCT_CATALOG'
    GROUP BY "shop" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'More than one ACTIVE PRODUCT_CATALOG MirrorBatch exists for a shop';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Store" s
    LEFT JOIN "MirrorBatch" b
      ON b."shop" = s."shopUrl" AND b."id" = s."activeMirrorBatchId"
    WHERE s."activeMirrorBatchId" IS NOT NULL AND b."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Store.activeMirrorBatchId contains a missing or cross-shop batch reference';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "ProductCodeSnippet"
    WHERE "isDeleted" = false
    GROUP BY "shop", LOWER(BTRIM("title")) HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate live ProductCodeSnippet titles must be resolved before migration';
  END IF;
END $$;

ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "mirrorMutationVersion" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "RecurringEdit" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ScheduledExport" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ScheduledExport" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "ScheduledExport" ADD COLUMN IF NOT EXISTS "deletedBy" TEXT;
ALTER TABLE "ProductCodeSnippet" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "SpreadsheetFile" ADD COLUMN IF NOT EXISTS "storageDeletedAt" TIMESTAMP(3);
ALTER TABLE "ExportHistory" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "ExportHistory" ADD COLUMN IF NOT EXISTS "storageDeletedAt" TIMESTAMP(3);
ALTER TABLE "ExportJob" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "ExportJob" ADD COLUMN IF NOT EXISTS "checksum" TEXT;
ALTER TABLE "ExportJob" ADD COLUMN IF NOT EXISTS "sizeBytes" BIGINT;
ALTER TABLE "ExportJob" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "ExportJob" ADD COLUMN IF NOT EXISTS "storageDeletedAt" TIMESTAMP(3);

ALTER TABLE "MirrorMutationJournal" ADD COLUMN IF NOT EXISTS "payloadStorageKey" TEXT;
ALTER TABLE "MirrorMutationJournal" ADD COLUMN IF NOT EXISTS "replayedAt" TIMESTAMP(3);
ALTER TABLE "MirrorMutationJournal" ADD COLUMN IF NOT EXISTS "purgeAfter" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "ExportJob_shop_id_key"
  ON "ExportJob" ("shop", "id");

ALTER TABLE "Store" ADD CONSTRAINT "Store_activeMirrorBatch_fkey"
  FOREIGN KEY ("shopUrl", "activeMirrorBatchId")
  REFERENCES "MirrorBatch" ("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "Store" VALIDATE CONSTRAINT "Store_activeMirrorBatch_fkey";

CREATE UNIQUE INDEX IF NOT EXISTS "MirrorBatch_one_active_product_catalog_per_shop_uq"
  ON "MirrorBatch" ("shop")
  WHERE "status" = 'ACTIVE' AND "resourceType" = 'PRODUCT_CATALOG';

CREATE INDEX IF NOT EXISTS "Product_tags_gin_idx"
  ON "Product" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS "FilterTrack_shop_type_createdAt_idx"
  ON "FilterTrack" ("shop", "type", "createdAt");
DROP INDEX IF EXISTS "FilterTrack_type_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "ProductCodeSnippet_live_title_uq"
  ON "ProductCodeSnippet" ("shop", LOWER(BTRIM("title")))
  WHERE "isDeleted" = false;

CREATE INDEX IF NOT EXISTS "RecurringEdit_active_due_idx"
  ON "RecurringEdit" ("nextRunAt", "id")
  WHERE "status" = 'ACTIVE' AND "isDeleted" = false AND "nextRunAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ScheduledExport_active_due_idx"
  ON "ScheduledExport" ("nextRunAt", "id")
  WHERE "status" = 'ACTIVE' AND "isDeleted" = false AND "nextRunAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "AutomaticProductRule_active_due_idx"
  ON "AutomaticProductRule" ("nextRunAt", "id")
  WHERE "status" = 'ACTIVE' AND "isDeleted" = false AND "nextRunAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "ProductCodeSnippet_live_updated_idx"
  ON "ProductCodeSnippet" ("shop", "updatedAt", "id")
  WHERE "isDeleted" = false;

CREATE TABLE IF NOT EXISTS "ExportJobCheckpoint" (
  "shop" TEXT NOT NULL,
  "exportJobId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "targetId" TEXT,
  "cursorJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExportJobCheckpoint_pkey" PRIMARY KEY ("shop", "exportJobId", "ordinal"),
  CONSTRAINT "ExportJobCheckpoint_exportJob_fkey"
    FOREIGN KEY ("shop", "exportJobId") REFERENCES "ExportJob" ("shop", "id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ExportJobCheckpoint_shop_exportJobId_status_ordinal_idx"
  ON "ExportJobCheckpoint" ("shop", "exportJobId", "status", "ordinal");

ALTER TABLE "ScheduledExportRun" ADD CONSTRAINT "ScheduledExportRun_shop_exportJobId_fkey"
  FOREIGN KEY ("shop", "exportJobId") REFERENCES "ExportJob" ("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "ScheduledExportRun" VALIDATE CONSTRAINT "ScheduledExportRun_shop_exportJobId_fkey";

CREATE INDEX IF NOT EXISTS "SpreadsheetFile_expiresAt_id_idx"
  ON "SpreadsheetFile" ("expiresAt", "id");
CREATE INDEX IF NOT EXISTS "ExportHistory_expiresAt_id_idx"
  ON "ExportHistory" ("expiresAt", "id");
CREATE INDEX IF NOT EXISTS "ExportJob_expiresAt_id_idx"
  ON "ExportJob" ("expiresAt", "id");
CREATE INDEX IF NOT EXISTS "MirrorMutationJournal_createdAt_idx"
  ON "MirrorMutationJournal" ("createdAt");
CREATE INDEX IF NOT EXISTS "MirrorMutationJournal_purgeAfter_sequence_idx"
  ON "MirrorMutationJournal" ("purgeAfter", "sequence");

-- Stable state invariants. NOT VALID minimizes lock duration before validation.
ALTER TABLE "RecurringEdit" ADD CONSTRAINT "RecurringEdit_time_order_check"
  CHECK ("endAt" IS NULL OR "startAt" IS NULL OR "startAt" <= "endAt") NOT VALID;
ALTER TABLE "ScheduledExport" ADD CONSTRAINT "ScheduledExport_time_order_check"
  CHECK ("endAt" IS NULL OR "startAt" IS NULL OR "startAt" <= "endAt") NOT VALID;
ALTER TABLE "AutomaticProductRule" ADD CONSTRAINT "AutomaticProductRule_time_order_check"
  CHECK ("endAt" IS NULL OR "startAt" IS NULL OR "startAt" <= "endAt") NOT VALID;
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_counts_and_time_check"
  CHECK (
    ("totalItems" IS NULL OR "totalItems" >= 0) AND
    ("targetSnapshotCount" >= 0) AND
    ("durationMs" IS NULL OR "durationMs" >= 0) AND
    ("completedAt" IS NULL OR "startedAt" IS NULL OR "startedAt" <= "completedAt") AND
    ("executionCursorOrdinal" IS NULL OR "executionCursorOrdinal" >= 0) AND
    ("sizeBytes" IS NULL OR "sizeBytes" >= 0)
  ) NOT VALID;
ALTER TABLE "ScheduledExportRun" ADD CONSTRAINT "ScheduledExportRun_counts_and_time_check"
  CHECK (
    ("totalItems" IS NULL OR "totalItems" >= 0) AND
    ("durationMs" IS NULL OR "durationMs" >= 0) AND
    ("completedAt" IS NULL OR "startedAt" IS NULL OR "startedAt" <= "completedAt")
  ) NOT VALID;
ALTER TABLE "SpreadsheetFile" ADD CONSTRAINT "SpreadsheetFile_retention_check"
  CHECK (
    ("totalRows" IS NULL OR "totalRows" >= 0) AND
    ("rowParseErrorCount" IS NULL OR "rowParseErrorCount" >= 0) AND
    ("expiresAt" IS NULL OR "expiresAt" > "createdAt")
  ) NOT VALID;
ALTER TABLE "ExportHistory" ADD CONSTRAINT "ExportHistory_retention_check"
  CHECK (
    ("totalItems" IS NULL OR "totalItems" >= 0) AND
    ("sizeBytes" IS NULL OR "sizeBytes" >= 0) AND
    ("expiresAt" IS NULL OR "expiresAt" > "createdAt")
  ) NOT VALID;
ALTER TABLE "ExportJobCheckpoint" ADD CONSTRAINT "ExportJobCheckpoint_ordinal_check"
  CHECK ("ordinal" >= 0) NOT VALID;
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_commerce_values_check"
  CHECK (
    ("position" IS NULL OR "position" >= 0) AND
    ("price" IS NULL OR "price" >= 0) AND
    ("compareAtPrice" IS NULL OR "compareAtPrice" >= 0)
  ) NOT VALID;
ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_counts_and_time_check"
  CHECK (
    "processedCount" >= 0 AND "totalItems" >= 0 AND "totalRows" >= 0 AND
    "durationMs" >= 0 AND "processedCount" <= "totalItems" AND
    ("completedAt" IS NULL OR "startedAt" <= "completedAt")
  ) NOT VALID;
ALTER TABLE "UndoOperation" ADD CONSTRAINT "UndoOperation_counts_and_time_check"
  CHECK (
    "processedCount" >= 0 AND "totalEligibleCount" >= 0 AND
    "restoredCount" >= 0 AND "failedCount" >= 0 AND "skippedCount" >= 0 AND
    "conflictedCount" >= 0 AND
    ("completedAt" IS NULL OR "startedAt" IS NULL OR "startedAt" <= "completedAt")
  ) NOT VALID;

ALTER TABLE "RecurringEdit" VALIDATE CONSTRAINT "RecurringEdit_time_order_check";
ALTER TABLE "ScheduledExport" VALIDATE CONSTRAINT "ScheduledExport_time_order_check";
ALTER TABLE "AutomaticProductRule" VALIDATE CONSTRAINT "AutomaticProductRule_time_order_check";
ALTER TABLE "ExportJob" VALIDATE CONSTRAINT "ExportJob_counts_and_time_check";
ALTER TABLE "ScheduledExportRun" VALIDATE CONSTRAINT "ScheduledExportRun_counts_and_time_check";
ALTER TABLE "SpreadsheetFile" VALIDATE CONSTRAINT "SpreadsheetFile_retention_check";
ALTER TABLE "ExportHistory" VALIDATE CONSTRAINT "ExportHistory_retention_check";
ALTER TABLE "ExportJobCheckpoint" VALIDATE CONSTRAINT "ExportJobCheckpoint_ordinal_check";
ALTER TABLE "Variant" VALIDATE CONSTRAINT "Variant_commerce_values_check";
ALTER TABLE "EditHistory" VALIDATE CONSTRAINT "EditHistory_counts_and_time_check";
ALTER TABLE "UndoOperation" VALIDATE CONSTRAINT "UndoOperation_counts_and_time_check";

-- Export payloads belong in object storage. Metadata remains in PostgreSQL.
ALTER TABLE "ExportHistory" DROP COLUMN IF EXISTS "exportedData";
