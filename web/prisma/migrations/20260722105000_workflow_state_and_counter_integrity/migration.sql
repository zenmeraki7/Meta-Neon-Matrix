-- Neon/PostgreSQL workflow-state and aggregate-integrity hardening.
-- Concurrent indexes require this migration to run without an outer transaction.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TargetFreezeCommandStatus') THEN
    CREATE TYPE "TargetFreezeCommandStatus" AS ENUM ('PENDING', 'DISPATCHING', 'DISPATCHED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkApplyRequestStatus') THEN
    CREATE TYPE "BulkApplyRequestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BulkApplyItemStatus') THEN
    CREATE TYPE "BulkApplyItemStatus" AS ENUM ('PENDING', 'APPLYING', 'APPLIED', 'FAILED', 'FAILED_PERMANENT', 'CANCELLED', 'SKIPPED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationStageStatus') THEN
    CREATE TYPE "OperationStageStatus" AS ENUM (
      'PREPARED_JSONL', 'PENDING_SUBMIT', 'WAITING_SLOT', 'STAGED_UPLOAD_CREATED',
      'UPLOADED', 'SUBMIT_RESPONSE_RECEIVED', 'SUBMITTED', 'WAITING', 'RUNNING',
      'RETRYABLE_FAILURE', 'QUEUE_FAILED', 'COMPLETED_EMPTY', 'COMPLETED',
      'PARTIAL_FAILED', 'FAILED', 'SKIPPED'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OperationEnqueueIntentStatus') THEN
    CREATE TYPE "OperationEnqueueIntentStatus" AS ENUM ('PENDING', 'DISPATCHING', 'DISPATCHED', 'FAILED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeadLetterResolution') THEN
    CREATE TYPE "DeadLetterResolution" AS ENUM ('RECOVERABLE', 'UNRECOVERABLE', 'RETRIED', 'RESOLVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MirrorReconcileSignalStatus') THEN
    CREATE TYPE "MirrorReconcileSignalStatus" AS ENUM ('PENDING', 'PROCESSING', 'RECONCILED', 'FAILED');
  END IF;
END $$;

-- Normalize the legacy terminal spelling to the authoritative lifecycle value.
UPDATE "MirrorReconcileSignal"
SET "status" = 'RECONCILED'
WHERE UPPER("status") = 'RESOLVED';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "TargetFreezeCommand" WHERE UPPER("status") NOT IN ('PENDING','DISPATCHING','DISPATCHED')) THEN
    RAISE EXCEPTION 'TargetFreezeCommand contains an unknown status';
  END IF;
  IF EXISTS (SELECT 1 FROM "BulkApplyRequest" WHERE UPPER("status") NOT IN ('QUEUED','RUNNING','COMPLETED','PARTIAL_FAILED','FAILED','CANCELLED')) THEN
    RAISE EXCEPTION 'BulkApplyRequest contains an unknown status';
  END IF;
  IF EXISTS (SELECT 1 FROM "BulkApplyItem" WHERE UPPER("status") NOT IN ('PENDING','APPLYING','APPLIED','FAILED','FAILED_PERMANENT','CANCELLED','SKIPPED')) THEN
    RAISE EXCEPTION 'BulkApplyItem contains an unknown status';
  END IF;
  IF EXISTS (SELECT 1 FROM "OperationStageProgress" WHERE UPPER("stageStatus") NOT IN (
    'PREPARED_JSONL','PENDING_SUBMIT','WAITING_SLOT','STAGED_UPLOAD_CREATED','UPLOADED',
    'SUBMIT_RESPONSE_RECEIVED','SUBMITTED','WAITING','RUNNING','RETRYABLE_FAILURE',
    'QUEUE_FAILED','COMPLETED_EMPTY','COMPLETED','PARTIAL_FAILED','FAILED','SKIPPED'
  )) THEN RAISE EXCEPTION 'OperationStageProgress contains an unknown stageStatus'; END IF;
  IF EXISTS (SELECT 1 FROM "OperationEnqueueIntent" WHERE UPPER("status") NOT IN ('PENDING','DISPATCHING','DISPATCHED','FAILED')) THEN
    RAISE EXCEPTION 'OperationEnqueueIntent contains an unknown status';
  END IF;
  IF EXISTS (SELECT 1 FROM "DeadLetterJob" WHERE "resolution" IS NOT NULL AND UPPER("resolution") NOT IN ('RECOVERABLE','UNRECOVERABLE','RETRIED','RESOLVED')) THEN
    RAISE EXCEPTION 'DeadLetterJob contains an unknown resolution';
  END IF;
  IF EXISTS (SELECT 1 FROM "MirrorReconcileSignal" WHERE UPPER("status") NOT IN ('PENDING','PROCESSING','RECONCILED','FAILED')) THEN
    RAISE EXCEPTION 'MirrorReconcileSignal contains an unknown status';
  END IF;
END $$;

ALTER TABLE "TargetFreezeCommand" ALTER COLUMN "status" TYPE "TargetFreezeCommandStatus" USING UPPER("status")::"TargetFreezeCommandStatus";

ALTER TABLE "BulkApplyRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "BulkApplyRequest" ALTER COLUMN "status" TYPE "BulkApplyRequestStatus" USING UPPER("status")::"BulkApplyRequestStatus";
ALTER TABLE "BulkApplyRequest" ALTER COLUMN "status" SET DEFAULT 'QUEUED'::"BulkApplyRequestStatus";

ALTER TABLE "BulkApplyItem" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "BulkApplyItem" ALTER COLUMN "status" TYPE "BulkApplyItemStatus" USING UPPER("status")::"BulkApplyItemStatus";
ALTER TABLE "BulkApplyItem" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"BulkApplyItemStatus";

ALTER TABLE "OperationStageProgress" ALTER COLUMN "stageStatus" TYPE "OperationStageStatus" USING UPPER("stageStatus")::"OperationStageStatus";

ALTER TABLE "OperationEnqueueIntent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "OperationEnqueueIntent" ALTER COLUMN "status" TYPE "OperationEnqueueIntentStatus" USING UPPER("status")::"OperationEnqueueIntentStatus";
ALTER TABLE "OperationEnqueueIntent" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"OperationEnqueueIntentStatus";

ALTER TABLE "DeadLetterJob" ALTER COLUMN "resolution" TYPE "DeadLetterResolution" USING UPPER("resolution")::"DeadLetterResolution";

ALTER TABLE "MirrorReconcileSignal" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "MirrorReconcileSignal" ALTER COLUMN "status" TYPE "MirrorReconcileSignalStatus" USING UPPER("status")::"MirrorReconcileSignalStatus";
ALTER TABLE "MirrorReconcileSignal" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"MirrorReconcileSignalStatus";

ALTER TABLE "BulkApplyItem" ADD COLUMN "requestId" TEXT;
UPDATE "BulkApplyItem" item
SET "requestId" = (
  SELECT request."id"
  FROM "BulkApplyRequest" request
  WHERE request."shop" = item."shop" AND request."bulkJobId" = item."bulkJobId"
  ORDER BY request."createdAt" ASC, request."id" ASC
  LIMIT 1
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "BulkApplyItem" WHERE "requestId" IS NULL) THEN
    RAISE EXCEPTION 'BulkApplyItem contains rows without a tenant-scoped BulkApplyRequest';
  END IF;
END $$;

ALTER TABLE "BulkApplyItem" ALTER COLUMN "requestId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "BulkApplyRequest_shop_id_key" ON "BulkApplyRequest" ("shop", "id");
ALTER TABLE "BulkApplyItem" ADD CONSTRAINT "BulkApplyItem_shop_requestId_fkey"
  FOREIGN KEY ("shop", "requestId") REFERENCES "BulkApplyRequest" ("shop", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "BulkApplyItem" VALIDATE CONSTRAINT "BulkApplyItem_shop_requestId_fkey";

-- Repair stored summaries from authoritative item rows before checks are installed.
WITH counts AS (
  SELECT
    request."id" AS "requestId",
    COUNT(item."id")::integer AS total,
    COUNT(*) FILTER (WHERE item."status" = 'APPLIED')::integer AS applied,
    COUNT(*) FILTER (WHERE item."status" IN ('FAILED','FAILED_PERMANENT'))::integer AS failed,
    COUNT(*) FILTER (WHERE item."status" = 'CANCELLED')::integer AS cancelled,
    COUNT(*) FILTER (WHERE item."status" = 'SKIPPED')::integer AS skipped
  FROM "BulkApplyRequest" request
  LEFT JOIN "BulkApplyItem" item ON item."shop" = request."shop" AND item."requestId" = request."id"
  GROUP BY request."id"
)
UPDATE "BulkApplyRequest" request
SET "totalCount" = counts.total,
    "appliedCount" = counts.applied,
    "failedCount" = counts.failed,
    "cancelledCount" = counts.cancelled,
    "skippedCount" = counts.skipped
FROM counts WHERE counts."requestId" = request."id";

WITH counts AS (
  SELECT
    setrow."id" AS "snapshotSetId",
    COUNT(item."id")::integer AS target_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'PENDING')::integer AS pending_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SUBMITTED')::integer AS submitted_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SUCCEEDED')::integer AS succeeded_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'FAILED')::integer AS failed_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'SKIPPED')::integer AS skipped_count,
    COUNT(*) FILTER (WHERE item."executionStatus" = 'VERIFIED')::integer AS verified_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'PENDING')::integer AS undo_pending_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'SUCCEEDED')::integer AS undo_succeeded_count,
    COUNT(*) FILTER (WHERE item."undoStatus" = 'FAILED')::integer AS undo_failed_count
  FROM "TargetSnapshotSet" setrow
  LEFT JOIN "TargetSnapshotItem" item ON item."shop" = setrow."shop" AND item."snapshotSetId" = setrow."id"
  GROUP BY setrow."id"
)
UPDATE "TargetSnapshotSet" setrow
SET "targetCount" = counts.target_count,
    "pendingCount" = counts.pending_count,
    "submittedCount" = counts.submitted_count,
    "succeededCount" = counts.succeeded_count,
    "failedCount" = counts.failed_count,
    "skippedCount" = counts.skipped_count,
    "verifiedCount" = counts.verified_count,
    "undoPendingCount" = counts.undo_pending_count,
    "undoSucceededCount" = counts.undo_succeeded_count,
    "undoFailedCount" = counts.undo_failed_count
FROM counts WHERE counts."snapshotSetId" = setrow."id";

ALTER TABLE "BulkApplyRequest" ADD CONSTRAINT "BulkApplyRequest_counter_bounds_check" CHECK (
  "totalCount" >= 0 AND "appliedCount" >= 0 AND "failedCount" >= 0 AND
  "cancelledCount" >= 0 AND "skippedCount" >= 0 AND
  "appliedCount" + "failedCount" + "cancelledCount" + "skippedCount" <= "totalCount"
) NOT VALID;
ALTER TABLE "BulkApplyRequest" VALIDATE CONSTRAINT "BulkApplyRequest_counter_bounds_check";

ALTER TABLE "TargetSnapshotSet" ADD CONSTRAINT "TargetSnapshotSet_counter_bounds_check" CHECK (
  "targetCount" >= 0 AND "productCount" >= 0 AND "variantCount" >= 0 AND
  "pendingCount" >= 0 AND "submittedCount" >= 0 AND "succeededCount" >= 0 AND
  "failedCount" >= 0 AND "skippedCount" >= 0 AND "verifiedCount" >= 0 AND
  "undoPendingCount" >= 0 AND "undoSucceededCount" >= 0 AND "undoFailedCount" >= 0 AND
  "pendingCount" + "submittedCount" + "succeededCount" + "failedCount" + "skippedCount" + "verifiedCount" <= "targetCount" AND
  "undoPendingCount" + "undoSucceededCount" + "undoFailedCount" <= "targetCount"
) NOT VALID;
ALTER TABLE "TargetSnapshotSet" VALIDATE CONSTRAINT "TargetSnapshotSet_counter_bounds_check";

ALTER TABLE "Store" ADD CONSTRAINT "Store_sync_stage_projection_check" CHECK (
  ("syncProgressStage" = 'IDLE' OR "isProductSyncing" = true) AND
  ("isProductInitialySyning" = false OR "isProductSyncing" = true)
) NOT VALID;
ALTER TABLE "Store" VALIDATE CONSTRAINT "Store_sync_stage_projection_check";

CREATE INDEX IF NOT EXISTS "Store_syncProgressStage_updatedAt_idx" ON "Store" ("syncProgressStage", "updatedAt");
CREATE INDEX IF NOT EXISTS "BulkApplyRequest_shop_status_createdAt_id_idx" ON "BulkApplyRequest" ("shop", "status", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "BulkApplyItem_shop_requestId_status_createdAt_id_idx" ON "BulkApplyItem" ("shop", "requestId", "status", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "BulkApplyItem_shop_status_createdAt_id_idx" ON "BulkApplyItem" ("shop", "status", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "TargetFreezeCommand_status_createdAt_id_idx" ON "TargetFreezeCommand" ("status", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "MirrorReconcileSignal_shop_status_updatedAt_entityId_idx" ON "MirrorReconcileSignal" ("shop", "status", "updatedAt", "entityId");
CREATE INDEX IF NOT EXISTS "OperationEnqueueIntent_shop_status_runAt_id_idx" ON "OperationEnqueueIntent" ("shop", "status", "runAt", "id");
CREATE INDEX IF NOT EXISTS "OperationEnqueueIntent_status_runAt_id_idx" ON "OperationEnqueueIntent" ("status", "runAt", "id");

DROP INDEX IF EXISTS "BulkApplyRequest_shop_status_idx";
DROP INDEX IF EXISTS "BulkApplyItem_shop_status_idx";
DROP INDEX IF EXISTS "TargetFreezeCommand_status_createdAt_idx";
DROP INDEX IF EXISTS "MirrorReconcileSignal_shop_status_updatedAt_idx";
DROP INDEX IF EXISTS "OperationEnqueueIntent_shop_status_runAt_idx";
DROP INDEX IF EXISTS "OperationEnqueueIntent_status_runAt_idx";
DROP INDEX IF EXISTS "shop_status_type_recent";
DROP INDEX IF EXISTS "EditHistory_shop_executionState_idx";
DROP INDEX IF EXISTS "WebhookDelivery_status_createdAt_idx";
