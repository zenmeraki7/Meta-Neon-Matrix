-- Split automatic-rule definitions from immutable revisions and narrow scheduler state.
-- This migration intentionally runs without an outer transaction: Neon/PostgreSQL
-- requires that for CONCURRENTLY-built indexes.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "RecurringEditRun" c JOIN "RecurringEdit" p ON p."id" = c."recurringEditId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "ScheduledExportRun" c JOIN "ScheduledExport" p ON p."id" = c."scheduledExportId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "AutomaticProductRuleRun" c JOIN "AutomaticProductRule" p ON p."id" = c."automaticProductRuleId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "AutomaticProductRuleProductState" c JOIN "AutomaticProductRule" p ON p."id" = c."automaticProductRuleId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "AutomaticRuleApplication" c JOIN "AutomaticProductRule" p ON p."id" = c."ruleId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "BulkEditRecoveryAudit" c JOIN "EditHistory" p ON p."id" = c."historyId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "EditHistoryIngestionCheckpoint" c JOIN "EditHistory" p ON p."id" = c."historyId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "ChangeRecord" c JOIN "EditHistory" p ON p."id" = c."editHistoryId"
    WHERE c."shop" <> p."shop"
  ) OR EXISTS (
    SELECT 1 FROM "UndoOperationConflictChunk" c JOIN "UndoOperation" p ON p."id" = c."undoOperationId"
    WHERE c."shop" <> p."shop"
  ) THEN
    RAISE EXCEPTION 'Tenant mismatch detected in a relation being converted to a composite foreign key';
  END IF;
END $$;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "RecurringEdit_shop_id_key"
  ON "RecurringEdit" ("shop", "id");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ScheduledExport_shop_id_key"
  ON "ScheduledExport" ("shop", "id");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "AutomaticProductRule_shop_id_key"
  ON "AutomaticProductRule" ("shop", "id");

CREATE TABLE IF NOT EXISTS "AutomaticProductRuleRevision" (
  "shop" TEXT NOT NULL,
  "automaticProductRuleId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "commandVersion" INTEGER NOT NULL,
  "configFingerprint" TEXT,
  "commandSnapshot" JSONB NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomaticProductRuleRevision_pkey"
    PRIMARY KEY ("shop", "automaticProductRuleId", "revision")
);

CREATE TABLE IF NOT EXISTS "AutomaticProductRuleScheduleState" (
  "shop" TEXT NOT NULL,
  "automaticProductRuleId" TEXT NOT NULL,
  "ruleRevision" INTEGER NOT NULL,
  "scheduleVersion" INTEGER NOT NULL DEFAULT 1,
  "scheduleConfig" JSONB,
  "nextRunAt" TIMESTAMP(3),
  "lastRunAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastFailureReason" TEXT,
  "disabledAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3),
  "claimOwner" TEXT,
  "fencingToken" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomaticProductRuleScheduleState_pkey"
    PRIMARY KEY ("shop", "automaticProductRuleId")
);

INSERT INTO "AutomaticProductRuleRevision" (
  "shop", "automaticProductRuleId", "revision", "commandVersion",
  "configFingerprint", "commandSnapshot", "createdBy", "createdAt"
)
SELECT r."shop", r."id", r."revision", r."commandVersion", r."configFingerprint",
       to_jsonb(r) - ARRAY[
         'runCount','lastRunAt','nextRunAt','lastSuccessAt','lastFailureAt',
         'lastFailureReason','schedulerClaimedAt','schedulerClaimId','schedulerDisabledAt',
         'createdAt','updatedAt'
       ],
       r."createdBy", r."createdAt"
FROM "AutomaticProductRule" r
ON CONFLICT ("shop", "automaticProductRuleId", "revision") DO NOTHING;

INSERT INTO "AutomaticProductRuleScheduleState" (
  "shop", "automaticProductRuleId", "ruleRevision", "scheduleVersion",
  "scheduleConfig", "nextRunAt", "lastRunAt", "lastSuccessAt", "lastFailureAt",
  "lastFailureReason", "disabledAt", "claimedAt", "claimOwner", "fencingToken", "updatedAt"
)
SELECT r."shop", r."id", r."revision", 1, COALESCE(r."scheduleConfig", r."scheduleJson"),
       r."nextRunAt", r."lastRunAt", r."lastSuccessAt", r."lastFailureAt",
       r."lastFailureReason", r."schedulerDisabledAt", r."schedulerClaimedAt",
       r."schedulerClaimId", CASE WHEN r."schedulerClaimId" IS NULL THEN 0 ELSE 1 END, r."updatedAt"
FROM "AutomaticProductRule" r
ON CONFLICT ("shop", "automaticProductRuleId") DO NOTHING;

ALTER TABLE "AutomaticProductRuleRevision"
  ADD CONSTRAINT "AutomaticProductRuleRevision_rule_fkey"
  FOREIGN KEY ("shop", "automaticProductRuleId")
  REFERENCES "AutomaticProductRule" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "AutomaticProductRuleRevision" VALIDATE CONSTRAINT "AutomaticProductRuleRevision_rule_fkey";
ALTER TABLE "AutomaticProductRuleScheduleState"
  ADD CONSTRAINT "AutomaticProductRuleScheduleState_rule_fkey"
  FOREIGN KEY ("shop", "automaticProductRuleId")
  REFERENCES "AutomaticProductRule" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "AutomaticProductRuleScheduleState" VALIDATE CONSTRAINT "AutomaticProductRuleScheduleState_rule_fkey";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "AutomaticProductRuleRevision_shop_createdAt_idx"
  ON "AutomaticProductRuleRevision" ("shop", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AutomaticProductRuleScheduleState_nextRunAt_automaticProductRuleId_idx"
  ON "AutomaticProductRuleScheduleState" ("nextRunAt", "automaticProductRuleId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AutomaticProductRuleScheduleState_shop_nextRunAt_automaticProductRuleId_idx"
  ON "AutomaticProductRuleScheduleState" ("shop", "nextRunAt", "automaticProductRuleId");

-- Add tenant-scoped FKs with low-lock validation, then remove legacy id-only FKs.
ALTER TABLE "RecurringEditRun" ADD CONSTRAINT "RecurringEditRun_shop_recurringEditId_fkey"
  FOREIGN KEY ("shop", "recurringEditId") REFERENCES "RecurringEdit" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "ScheduledExportRun" ADD CONSTRAINT "ScheduledExportRun_shop_scheduledExportId_fkey"
  FOREIGN KEY ("shop", "scheduledExportId") REFERENCES "ScheduledExport" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "AutomaticProductRuleRun" ADD CONSTRAINT "AutomaticProductRuleRun_shop_automaticProductRuleId_fkey"
  FOREIGN KEY ("shop", "automaticProductRuleId") REFERENCES "AutomaticProductRule" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "AutomaticProductRuleProductState" ADD CONSTRAINT "AutomaticProductRuleProductState_shop_automaticProductRuleId_fkey"
  FOREIGN KEY ("shop", "automaticProductRuleId") REFERENCES "AutomaticProductRule" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "AutomaticRuleApplication" ADD CONSTRAINT "AutomaticRuleApplication_shop_ruleId_fkey"
  FOREIGN KEY ("shop", "ruleId") REFERENCES "AutomaticProductRule" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "BulkEditRecoveryAudit" ADD CONSTRAINT "BulkEditRecoveryAudit_shop_historyId_fkey"
  FOREIGN KEY ("shop", "historyId") REFERENCES "EditHistory" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "EditHistoryIngestionCheckpoint" ADD CONSTRAINT "EditHistoryIngestionCheckpoint_shop_historyId_fkey"
  FOREIGN KEY ("shop", "historyId") REFERENCES "EditHistory" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "ChangeRecord" ADD CONSTRAINT "ChangeRecord_shop_editHistoryId_fkey"
  FOREIGN KEY ("shop", "editHistoryId") REFERENCES "EditHistory" ("shop", "id") ON DELETE CASCADE NOT VALID;
ALTER TABLE "UndoOperationConflictChunk" ADD CONSTRAINT "UndoOperationConflictChunk_shop_undoOperationId_fkey"
  FOREIGN KEY ("shop", "undoOperationId") REFERENCES "UndoOperation" ("shop", "id") ON DELETE CASCADE NOT VALID;

ALTER TABLE "RecurringEditRun" VALIDATE CONSTRAINT "RecurringEditRun_shop_recurringEditId_fkey";
ALTER TABLE "ScheduledExportRun" VALIDATE CONSTRAINT "ScheduledExportRun_shop_scheduledExportId_fkey";
ALTER TABLE "AutomaticProductRuleRun" VALIDATE CONSTRAINT "AutomaticProductRuleRun_shop_automaticProductRuleId_fkey";
ALTER TABLE "AutomaticProductRuleProductState" VALIDATE CONSTRAINT "AutomaticProductRuleProductState_shop_automaticProductRuleId_fkey";
ALTER TABLE "AutomaticRuleApplication" VALIDATE CONSTRAINT "AutomaticRuleApplication_shop_ruleId_fkey";
ALTER TABLE "BulkEditRecoveryAudit" VALIDATE CONSTRAINT "BulkEditRecoveryAudit_shop_historyId_fkey";
ALTER TABLE "EditHistoryIngestionCheckpoint" VALIDATE CONSTRAINT "EditHistoryIngestionCheckpoint_shop_historyId_fkey";
ALTER TABLE "ChangeRecord" VALIDATE CONSTRAINT "ChangeRecord_shop_editHistoryId_fkey";
ALTER TABLE "UndoOperationConflictChunk" VALIDATE CONSTRAINT "UndoOperationConflictChunk_shop_undoOperationId_fkey";

ALTER TABLE "RecurringEditRun" DROP CONSTRAINT IF EXISTS "RecurringEditRun_recurringEditId_fkey";
ALTER TABLE "ScheduledExportRun" DROP CONSTRAINT IF EXISTS "ScheduledExportRun_scheduledExportId_fkey";
ALTER TABLE "AutomaticProductRuleRun" DROP CONSTRAINT IF EXISTS "AutomaticProductRuleRun_automaticProductRuleId_fkey";
ALTER TABLE "AutomaticProductRuleProductState" DROP CONSTRAINT IF EXISTS "AutomaticProductRuleProductState_automaticProductRuleId_fkey";
ALTER TABLE "AutomaticRuleApplication" DROP CONSTRAINT IF EXISTS "AutomaticRuleApplication_ruleId_fkey";
ALTER TABLE "BulkEditRecoveryAudit" DROP CONSTRAINT IF EXISTS "BulkEditRecoveryAudit_historyId_fkey";
ALTER TABLE "EditHistoryIngestionCheckpoint" DROP CONSTRAINT IF EXISTS "EditHistoryIngestionCheckpoint_historyId_fkey";
ALTER TABLE "ChangeRecord" DROP CONSTRAINT IF EXISTS "ChangeRecord_editHistoryId_fkey";
ALTER TABLE "UndoOperationConflictChunk" DROP CONSTRAINT IF EXISTS "UndoOperationConflictChunk_undoOperationId_fkey";

-- A lease has one natural identity; fencing tokens are always positive and are
-- incremented atomically by the acquisition statement.
UPDATE "OperationLease" SET "fencingToken" = 1 WHERE "fencingToken" < 1;
ALTER TABLE "OperationLease" DROP CONSTRAINT IF EXISTS "OperationLease_pkey";
ALTER TABLE "OperationLease" ADD CONSTRAINT "OperationLease_pkey"
  PRIMARY KEY USING INDEX "OperationLease_shop_namespace_resourceId_key";
ALTER TABLE "OperationLease" DROP COLUMN IF EXISTS "id";
ALTER TABLE "OperationLease" ADD CONSTRAINT "OperationLease_fencingToken_check"
  CHECK ("fencingToken" > 0) NOT VALID;
ALTER TABLE "OperationLease" VALIDATE CONSTRAINT "OperationLease_fencingToken_check";

ALTER TABLE "Suggestion" ADD COLUMN IF NOT EXISTS "emailNormalized" TEXT;
UPDATE "Suggestion" SET "emailNormalized" = LOWER(BTRIM("email")) WHERE "emailNormalized" IS NULL;
ALTER TABLE "Suggestion" ALTER COLUMN "emailNormalized" SET NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Suggestion_emailNormalized_idx" ON "Suggestion" ("emailNormalized");
DROP INDEX CONCURRENTLY IF EXISTS "Suggestion_email_idx";

-- Referral capture is one current attribution per shop; preserve the newest row.
DELETE FROM "ReferralCode" older USING "ReferralCode" newer
WHERE older."shop" = newer."shop"
  AND (older."createdAt", older."id") < (newer."createdAt", newer."id");
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "ReferralCode_shop_key" ON "ReferralCode" ("shop");
DROP INDEX CONCURRENTLY IF EXISTS "ReferralCode_shop_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ErrorLog_createdAt_idx" ON "ErrorLog" ("createdAt");
ALTER TABLE "ErrorLog" DROP COLUMN IF EXISTS "request";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "DeadLetterChange_notified_failedAt_idx"
  ON "DeadLetterChange" ("notified", "failedAt");
DROP INDEX CONCURRENTLY IF EXISTS "DeadLetterChange_notified_idx";
CREATE INDEX CONCURRENTLY IF NOT EXISTS "DeadLetterJob_resolvedAt_failedAt_idx"
  ON "DeadLetterJob" ("resolvedAt", "failedAt");
DROP INDEX CONCURRENTLY IF EXISTS "DeadLetterJob_resolvedAt_idx";

ALTER TABLE "AutomaticProductRule"
  DROP COLUMN IF EXISTS "schedulerClaimedAt",
  DROP COLUMN IF EXISTS "schedulerClaimId";
