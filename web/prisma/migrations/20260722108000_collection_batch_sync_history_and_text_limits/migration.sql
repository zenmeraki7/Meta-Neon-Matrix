-- Tenant-safe collection activation, SyncHistory ownership, and bounded text.
-- Concurrent indexes require this migration to run without an outer transaction.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Store" s
    LEFT JOIN "MirrorBatch" b
      ON b."shop" = s."shopUrl" AND b."id" = s."activeCollectionBatchId"
    WHERE s."activeCollectionBatchId" IS NOT NULL
      AND (b."id" IS NULL OR b."resourceType" <> 'COLLECTION_CATALOG')
  ) THEN
    RAISE EXCEPTION 'Store.activeCollectionBatchId contains a missing, cross-shop, or non-collection batch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MirrorBatch" b
    JOIN "SyncHistory" h ON h."id" = b."syncHistoryId"
    WHERE b."syncHistoryId" IS NOT NULL AND b."shop" <> h."shop"
  ) THEN
    RAISE EXCEPTION 'MirrorBatch.syncHistoryId contains a cross-shop reference';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "MirrorBatch"
    WHERE "syncHistoryId" IS NOT NULL
    GROUP BY "shop", "syncHistoryId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'More than one MirrorBatch references the same shop-scoped SyncHistory';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "SyncHistory_shop_id_key"
  ON "SyncHistory" ("shop", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "MirrorBatch_shop_syncHistoryId_key"
  ON "MirrorBatch" ("shop", "syncHistoryId");

ALTER TABLE "Store" ADD CONSTRAINT "Store_activeCollectionBatch_fkey"
  FOREIGN KEY ("shopUrl", "activeCollectionBatchId")
  REFERENCES "MirrorBatch" ("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "Store" VALIDATE CONSTRAINT "Store_activeCollectionBatch_fkey";

ALTER TABLE "MirrorBatch" ADD CONSTRAINT "MirrorBatch_shop_syncHistoryId_fkey"
  FOREIGN KEY ("shop", "syncHistoryId")
  REFERENCES "SyncHistory" ("shop", "id") ON DELETE RESTRICT NOT VALID;
ALTER TABLE "MirrorBatch" VALIDATE CONSTRAINT "MirrorBatch_shop_syncHistoryId_fkey";

ALTER TABLE "MirrorBatch" DROP CONSTRAINT IF EXISTS "MirrorBatch_syncHistoryId_fkey";
DROP INDEX IF EXISTS "MirrorBatch_syncHistoryId_key";

-- NOT VALID first keeps the initial lock short; validation reports legacy rows
-- that must be trimmed instead of silently accepting additional oversized data.
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_text_length_check"
  CHECK (
    LENGTH("message") <= 8000 AND
    ("stack" IS NULL OR LENGTH("stack") <= 32000)
  ) NOT VALID;
ALTER TABLE "DeadLetterJob" ADD CONSTRAINT "DeadLetterJob_error_length_check"
  CHECK ("error" IS NULL OR LENGTH("error") <= 16000) NOT VALID;
ALTER TABLE "MirrorAnomaly" ADD CONSTRAINT "MirrorAnomaly_message_length_check"
  CHECK (LENGTH("message") <= 8000) NOT VALID;
ALTER TABLE "Suggestion" ADD CONSTRAINT "Suggestion_text_length_check"
  CHECK (LENGTH("suggestion") <= 8000 AND LENGTH("email") <= 320 AND LENGTH("emailNormalized") <= 320) NOT VALID;
ALTER TABLE "ProductCodeSnippet" ADD CONSTRAINT "ProductCodeSnippet_code_length_check"
  CHECK (LENGTH("title") <= 255 AND LENGTH("code") <= 262144) NOT VALID;
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_filterQuery_length_check"
  CHECK (LENGTH("filterQuery") <= 65536 AND ("error" IS NULL OR LENGTH("error") <= 16000)) NOT VALID;
ALTER TABLE "RecurringEdit" ADD CONSTRAINT "RecurringEdit_failure_length_check"
  CHECK ("lastFailureReason" IS NULL OR LENGTH("lastFailureReason") <= 8000) NOT VALID;
ALTER TABLE "ScheduledExport" ADD CONSTRAINT "ScheduledExport_failure_length_check"
  CHECK ("lastFailureReason" IS NULL OR LENGTH("lastFailureReason") <= 8000) NOT VALID;
ALTER TABLE "AutomaticProductRule" ADD CONSTRAINT "AutomaticProductRule_failure_length_check"
  CHECK ("lastFailureReason" IS NULL OR LENGTH("lastFailureReason") <= 8000) NOT VALID;
ALTER TABLE "SyncHistory" ADD CONSTRAINT "SyncHistory_error_length_check"
  CHECK ("errorMessage" IS NULL OR LENGTH("errorMessage") <= 8000) NOT VALID;
ALTER TABLE "MirrorBatch" ADD CONSTRAINT "MirrorBatch_failure_length_check"
  CHECK ("failureReason" IS NULL OR LENGTH("failureReason") <= 8000) NOT VALID;
ALTER TABLE "RecurringEditRun" ADD CONSTRAINT "RecurringEditRun_error_length_check"
  CHECK ("errorMessage" IS NULL OR LENGTH("errorMessage") <= 8000) NOT VALID;
ALTER TABLE "ScheduledExportRun" ADD CONSTRAINT "ScheduledExportRun_error_length_check"
  CHECK ("errorMessage" IS NULL OR LENGTH("errorMessage") <= 8000) NOT VALID;
ALTER TABLE "AutomaticProductRuleRun" ADD CONSTRAINT "AutomaticProductRuleRun_error_length_check"
  CHECK ("errorMessage" IS NULL OR LENGTH("errorMessage") <= 8000) NOT VALID;

ALTER TABLE "ErrorLog" VALIDATE CONSTRAINT "ErrorLog_text_length_check";
ALTER TABLE "DeadLetterJob" VALIDATE CONSTRAINT "DeadLetterJob_error_length_check";
ALTER TABLE "MirrorAnomaly" VALIDATE CONSTRAINT "MirrorAnomaly_message_length_check";
ALTER TABLE "Suggestion" VALIDATE CONSTRAINT "Suggestion_text_length_check";
ALTER TABLE "ProductCodeSnippet" VALIDATE CONSTRAINT "ProductCodeSnippet_code_length_check";
ALTER TABLE "ExportJob" VALIDATE CONSTRAINT "ExportJob_filterQuery_length_check";
ALTER TABLE "RecurringEdit" VALIDATE CONSTRAINT "RecurringEdit_failure_length_check";
ALTER TABLE "ScheduledExport" VALIDATE CONSTRAINT "ScheduledExport_failure_length_check";
ALTER TABLE "AutomaticProductRule" VALIDATE CONSTRAINT "AutomaticProductRule_failure_length_check";
ALTER TABLE "SyncHistory" VALIDATE CONSTRAINT "SyncHistory_error_length_check";
ALTER TABLE "MirrorBatch" VALIDATE CONSTRAINT "MirrorBatch_failure_length_check";
ALTER TABLE "RecurringEditRun" VALIDATE CONSTRAINT "RecurringEditRun_error_length_check";
ALTER TABLE "ScheduledExportRun" VALIDATE CONSTRAINT "ScheduledExportRun_error_length_check";
ALTER TABLE "AutomaticProductRuleRun" VALIDATE CONSTRAINT "AutomaticProductRuleRun_error_length_check";
