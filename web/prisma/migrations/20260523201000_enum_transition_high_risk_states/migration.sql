DO $$
BEGIN
  CREATE TYPE "EditHistoryExecutionState" AS ENUM (
    'PLANNED','QUEUED','DISPATCHING','AWAITING_SHOPIFY','FINALIZING','COMPLETED','FAILED','PARTIAL','CANCELLED','UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "EditHistoryStatus" AS ENUM (
    'PENDING','PROCESSING','COMPLETED','FAILED','PARTIAL','UNDO_PENDING','UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ExportJobExecutionState" AS ENUM (
    'PLANNED','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ExportJobStatus" AS ENUM (
    'PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED','UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "WebhookDeliveryStatus" AS ENUM (
    'RECEIVED','QUEUED','PROCESSING','PROCESSED','FAILED','IGNORED','UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "EditHistory"
  ADD COLUMN IF NOT EXISTS "executionStateNormalized" "EditHistoryExecutionState",
  ADD COLUMN IF NOT EXISTS "statusNormalized" "EditHistoryStatus";

ALTER TABLE "ExportJob"
  ADD COLUMN IF NOT EXISTS "executionStateNormalized" "ExportJobExecutionState",
  ADD COLUMN IF NOT EXISTS "statusNormalized" "ExportJobStatus";

ALTER TABLE "WebhookDelivery"
  ADD COLUMN IF NOT EXISTS "statusNormalized" "WebhookDeliveryStatus";

UPDATE "EditHistory"
SET "executionStateNormalized" = CASE UPPER(COALESCE("executionState", ''))
  WHEN 'PLANNED' THEN 'PLANNED'::"EditHistoryExecutionState"
  WHEN 'QUEUED' THEN 'QUEUED'::"EditHistoryExecutionState"
  WHEN 'DISPATCHING' THEN 'DISPATCHING'::"EditHistoryExecutionState"
  WHEN 'AWAITING_SHOPIFY' THEN 'AWAITING_SHOPIFY'::"EditHistoryExecutionState"
  WHEN 'FINALIZING' THEN 'FINALIZING'::"EditHistoryExecutionState"
  WHEN 'COMPLETED' THEN 'COMPLETED'::"EditHistoryExecutionState"
  WHEN 'FAILED' THEN 'FAILED'::"EditHistoryExecutionState"
  WHEN 'PARTIAL' THEN 'PARTIAL'::"EditHistoryExecutionState"
  WHEN 'CANCELLED' THEN 'CANCELLED'::"EditHistoryExecutionState"
  ELSE 'UNKNOWN'::"EditHistoryExecutionState"
END
WHERE "executionStateNormalized" IS NULL;

UPDATE "EditHistory"
SET "statusNormalized" = CASE UPPER(COALESCE("status", ''))
  WHEN 'PENDING' THEN 'PENDING'::"EditHistoryStatus"
  WHEN 'PROCESSING' THEN 'PROCESSING'::"EditHistoryStatus"
  WHEN 'COMPLETED' THEN 'COMPLETED'::"EditHistoryStatus"
  WHEN 'FAILED' THEN 'FAILED'::"EditHistoryStatus"
  WHEN 'PARTIAL' THEN 'PARTIAL'::"EditHistoryStatus"
  WHEN 'UNDO PENDING' THEN 'UNDO_PENDING'::"EditHistoryStatus"
  WHEN 'UNDO_PENDING' THEN 'UNDO_PENDING'::"EditHistoryStatus"
  ELSE 'UNKNOWN'::"EditHistoryStatus"
END
WHERE "statusNormalized" IS NULL;

UPDATE "ExportJob"
SET "executionStateNormalized" = CASE UPPER(COALESCE("executionState", ''))
  WHEN 'PLANNED' THEN 'PLANNED'::"ExportJobExecutionState"
  WHEN 'QUEUED' THEN 'QUEUED'::"ExportJobExecutionState"
  WHEN 'RUNNING' THEN 'RUNNING'::"ExportJobExecutionState"
  WHEN 'COMPLETED' THEN 'COMPLETED'::"ExportJobExecutionState"
  WHEN 'FAILED' THEN 'FAILED'::"ExportJobExecutionState"
  WHEN 'CANCELLED' THEN 'CANCELLED'::"ExportJobExecutionState"
  ELSE 'UNKNOWN'::"ExportJobExecutionState"
END
WHERE "executionStateNormalized" IS NULL;

UPDATE "ExportJob"
SET "statusNormalized" = CASE UPPER(COALESCE("status", ''))
  WHEN 'PENDING' THEN 'PENDING'::"ExportJobStatus"
  WHEN 'PROCESSING' THEN 'PROCESSING'::"ExportJobStatus"
  WHEN 'COMPLETED' THEN 'COMPLETED'::"ExportJobStatus"
  WHEN 'FAILED' THEN 'FAILED'::"ExportJobStatus"
  WHEN 'CANCELLED' THEN 'CANCELLED'::"ExportJobStatus"
  ELSE 'UNKNOWN'::"ExportJobStatus"
END
WHERE "statusNormalized" IS NULL;

UPDATE "WebhookDelivery"
SET "statusNormalized" = CASE UPPER(COALESCE("status", ''))
  WHEN 'RECEIVED' THEN 'RECEIVED'::"WebhookDeliveryStatus"
  WHEN 'QUEUED' THEN 'QUEUED'::"WebhookDeliveryStatus"
  WHEN 'PROCESSING' THEN 'PROCESSING'::"WebhookDeliveryStatus"
  WHEN 'PROCESSED' THEN 'PROCESSED'::"WebhookDeliveryStatus"
  WHEN 'FAILED' THEN 'FAILED'::"WebhookDeliveryStatus"
  WHEN 'IGNORED' THEN 'IGNORED'::"WebhookDeliveryStatus"
  ELSE 'UNKNOWN'::"WebhookDeliveryStatus"
END
WHERE "statusNormalized" IS NULL;

ALTER TABLE "EditHistory"
  ALTER COLUMN "executionStateNormalized" SET DEFAULT 'PLANNED'::"EditHistoryExecutionState",
  ALTER COLUMN "statusNormalized" SET DEFAULT 'PENDING'::"EditHistoryStatus",
  ALTER COLUMN "executionStateNormalized" SET NOT NULL,
  ALTER COLUMN "statusNormalized" SET NOT NULL;

ALTER TABLE "ExportJob"
  ALTER COLUMN "executionStateNormalized" SET DEFAULT 'PLANNED'::"ExportJobExecutionState",
  ALTER COLUMN "statusNormalized" SET DEFAULT 'PENDING'::"ExportJobStatus",
  ALTER COLUMN "executionStateNormalized" SET NOT NULL,
  ALTER COLUMN "statusNormalized" SET NOT NULL;

ALTER TABLE "WebhookDelivery"
  ALTER COLUMN "statusNormalized" SET DEFAULT 'RECEIVED'::"WebhookDeliveryStatus",
  ALTER COLUMN "statusNormalized" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "EditHistory_shop_executionStateNormalized_idx"
  ON "EditHistory"("shop", "executionStateNormalized");

CREATE INDEX IF NOT EXISTS "shop_status_norm_type_recent"
  ON "EditHistory"("shop", "statusNormalized", "type", "updatedAt");

CREATE INDEX IF NOT EXISTS "ExportJob_shop_executionStateNormalized_idx"
  ON "ExportJob"("shop", "executionStateNormalized");

CREATE INDEX IF NOT EXISTS "ExportJob_statusNormalized_idx"
  ON "ExportJob"("statusNormalized");

CREATE INDEX IF NOT EXISTS "WebhookDelivery_statusNormalized_createdAt_idx"
  ON "WebhookDelivery"("statusNormalized", "createdAt");
