-- Kept transaction-safe so Prisma Migrate can replay it in the shadow database.

-- Store.shopUrl is the canonical tenant key. Abort instead of creating cross-root relations.
DO $$
BEGIN
  IF EXISTS (
    SELECT "shop_id" FROM "variant_metafields" v
    WHERE NOT EXISTS (SELECT 1 FROM "Store" s WHERE s."shopUrl" = v."shop_id")
    UNION ALL
    SELECT "shop_id" FROM "bulk_edit_sessions" b
    WHERE NOT EXISTS (SELECT 1 FROM "Store" s WHERE s."shopUrl" = b."shop_id")
    UNION ALL
    SELECT "shop_id" FROM "sync_cursors" c
    WHERE NOT EXISTS (SELECT 1 FROM "Store" s WHERE s."shopUrl" = c."shop_id")
  ) THEN
    RAISE EXCEPTION 'Legacy shop reference has no matching Store.shopUrl';
  END IF;
END $$;

ALTER TABLE "variant_metafields" ADD CONSTRAINT "variant_metafields_store_shop_url_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "Store" ("shopUrl") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "variant_metafields" VALIDATE CONSTRAINT "variant_metafields_store_shop_url_fkey";
ALTER TABLE "variant_metafields" DROP CONSTRAINT IF EXISTS "variant_metafields_shop_id_fkey";
ALTER TABLE "variant_metafields" RENAME CONSTRAINT "variant_metafields_store_shop_url_fkey" TO "variant_metafields_shop_id_fkey";

ALTER TABLE "bulk_edit_sessions" ADD CONSTRAINT "bulk_edit_sessions_store_shop_url_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "Store" ("shopUrl") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "bulk_edit_sessions" VALIDATE CONSTRAINT "bulk_edit_sessions_store_shop_url_fkey";
ALTER TABLE "bulk_edit_sessions" DROP CONSTRAINT IF EXISTS "bulk_edit_sessions_shop_id_fkey";
ALTER TABLE "bulk_edit_sessions" RENAME CONSTRAINT "bulk_edit_sessions_store_shop_url_fkey" TO "bulk_edit_sessions_shop_id_fkey";

ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_store_shop_url_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "Store" ("shopUrl") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "sync_cursors" VALIDATE CONSTRAINT "sync_cursors_store_shop_url_fkey";
ALTER TABLE "sync_cursors" DROP CONSTRAINT IF EXISTS "sync_cursors_shop_id_fkey";
ALTER TABLE "sync_cursors" RENAME CONSTRAINT "sync_cursors_store_shop_url_fkey" TO "sync_cursors_shop_id_fkey";

-- Stable keyset pagination indexes.
CREATE INDEX IF NOT EXISTS "SyncHistory_shop_createdAt_id_idx" ON "SyncHistory" ("shop", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "SyncHistory_shop_status_updatedAt_id_idx" ON "SyncHistory" ("shop", "status", "updatedAt", "id");
CREATE INDEX IF NOT EXISTS "EditHistory_shop_createdAt_id_idx" ON "EditHistory" ("shop", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "EditHistory_shop_statusNormalized_updatedAt_id_idx" ON "EditHistory" ("shop", "statusNormalized", "updatedAt", "id");
CREATE INDEX IF NOT EXISTS "BulkEditSession_shop_id_created_at_id_idx" ON "bulk_edit_sessions" ("shop_id", "created_at", "id");
CREATE INDEX IF NOT EXISTS "ExportHistory_shop_createdAt_id_idx" ON "ExportHistory" ("shop", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "RecurringEditRun_shop_scheduledFor_id_idx" ON "RecurringEditRun" ("shop", "scheduledFor", "id");
CREATE INDEX IF NOT EXISTS "ScheduledExportRun_shop_scheduledFor_id_idx" ON "ScheduledExportRun" ("shop", "scheduledFor", "id");
CREATE INDEX IF NOT EXISTS "ExportJob_shop_createdAt_id_idx" ON "ExportJob" ("shop", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "ExportJob_shop_statusNormalized_createdAt_id_idx" ON "ExportJob" ("shop", "statusNormalized", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "ExportJob_shop_executionStateNormalized_updatedAt_id_idx" ON "ExportJob" ("shop", "executionStateNormalized", "updatedAt", "id");
CREATE INDEX IF NOT EXISTS "ChangeRecord_shop_editHistoryId_createdAt_id_idx" ON "ChangeRecord" ("shop", "editHistoryId", "createdAt", "id");

DROP INDEX IF EXISTS "SyncHistory_shop_createdAt_idx";
DROP INDEX IF EXISTS "SyncHistory_shop_status_idx";
DROP INDEX IF EXISTS "BulkEditSession_shop_id_created_at_idx";
DROP INDEX IF EXISTS "ExportHistory_shop_createdAt_idx";
DROP INDEX IF EXISTS "RecurringEditRun_shop_scheduledFor_idx";
DROP INDEX IF EXISTS "ScheduledExportRun_shop_scheduledFor_idx";
DROP INDEX IF EXISTS "ExportJob_shop_statusNormalized_createdAt_idx";
DROP INDEX IF EXISTS "ExportJob_shop_executionStateNormalized_updatedAt_idx";

-- NULL deliberately opts out of idempotency. Non-null identities remain unique.
CREATE UNIQUE INDEX IF NOT EXISTS "operation_enqueue_intent_dedupe_uq"
  ON "OperationEnqueueIntent" ("shop", "queueKey", "dedupeKey") WHERE "dedupeKey" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "export_history_scheduled_task_uq"
  ON "ExportHistory" ("shop", "scheduledTask") WHERE "scheduledTask" IS NOT NULL;
DROP INDEX IF EXISTS "OperationEnqueueIntent_shop_queueKey_dedupeKey_key";
DROP INDEX IF EXISTS "ExportHistory_shop_scheduledTask_key";

-- Claim-ready scheduler indexes; advisory locks/claim CAS remain the correctness boundary.
CREATE INDEX IF NOT EXISTS "recurring_edit_due_idx"
  ON "RecurringEdit" ("nextRunAt", "createdAt", "id")
  WHERE "status" = 'ACTIVE' AND "isDeleted" = false AND "nextRunAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "scheduled_export_due_idx"
  ON "ScheduledExport" ("nextRunAt", "createdAt", "id")
  WHERE "status" = 'ACTIVE' AND "isDeleted" = false AND "nextRunAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "automatic_product_rule_due_idx"
  ON "AutomaticProductRule" ("priority", "nextRunAt", "createdAt", "id")
  WHERE "status" = 'ACTIVE' AND "isDeleted" = false
    AND "schedulerDisabledAt" IS NULL AND "nextRunAt" IS NOT NULL;
DROP INDEX IF EXISTS "RecurringEdit_nextRunAt_idx";
DROP INDEX IF EXISTS "ScheduledExport_nextRunAt_idx";
DROP INDEX IF EXISTS "AutomaticProductRule_status_nextRunAt_idx";

-- Remove indexes already supplied by unique constraints.
DROP INDEX IF EXISTS "Subscription_shop_idx";
DROP INDEX IF EXISTS "AffiliateUser_referralCode_idx";
DROP INDEX IF EXISTS "Store_referralCode_idx";

ALTER TABLE "MirrorReconcileSignal" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "OperationFingerprint" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "updatedAt" DROP DEFAULT;
