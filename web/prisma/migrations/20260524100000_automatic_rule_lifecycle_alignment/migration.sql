-- Automatic rule lifecycle alignment migration

-- 1) Expand rule status enum and migrate values.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleStatus') THEN
    ALTER TYPE "AutomaticProductRuleStatus" RENAME TO "AutomaticProductRuleStatus_old";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleStatus') THEN
    CREATE TYPE "AutomaticProductRuleStatus" AS ENUM ('DRAFT','ACTIVE','PAUSED','DELETED');
  END IF;
END $$;

ALTER TABLE "AutomaticProductRule"
  ALTER COLUMN "status" TYPE "AutomaticProductRuleStatus"
  USING (
    CASE
      WHEN "status"::text = 'FAILED' THEN 'PAUSED'::"AutomaticProductRuleStatus"
      WHEN "status"::text = 'CANCELLED' THEN 'DELETED'::"AutomaticProductRuleStatus"
      ELSE "status"::text::"AutomaticProductRuleStatus"
    END
  );

DROP TYPE IF EXISTS "AutomaticProductRuleStatus_old";

-- 2) Expand run status enum and migrate values.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleRunStatus') THEN
    ALTER TYPE "AutomaticProductRuleRunStatus" RENAME TO "AutomaticProductRuleRunStatus_old";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutomaticProductRuleRunStatus') THEN
    CREATE TYPE "AutomaticProductRuleRunStatus" AS ENUM (
      'TARGET_FREEZE_QUEUED',
      'TARGET_FREEZING',
      'TARGET_FROZEN',
      'EXECUTING',
      'VERIFYING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'UNDO_PENDING',
      'UNDO_EXECUTING'
    );
  END IF;
END $$;

ALTER TABLE "AutomaticProductRuleRun"
  ALTER COLUMN "status" TYPE "AutomaticProductRuleRunStatus"
  USING (
    CASE
      WHEN "status"::text = 'PENDING' THEN 'TARGET_FREEZE_QUEUED'::"AutomaticProductRuleRunStatus"
      WHEN "status"::text = 'PROCESSING' THEN 'EXECUTING'::"AutomaticProductRuleRunStatus"
      WHEN "status"::text = 'SUCCESS' THEN 'SUCCEEDED'::"AutomaticProductRuleRunStatus"
      WHEN "status"::text = 'SKIPPED' THEN 'CANCELLED'::"AutomaticProductRuleRunStatus"
      ELSE "status"::text::"AutomaticProductRuleRunStatus"
    END
  );

ALTER TABLE "AutomaticProductRuleRun"
  ALTER COLUMN "status" SET DEFAULT 'TARGET_FREEZE_QUEUED';

DROP TYPE IF EXISTS "AutomaticProductRuleRunStatus_old";

-- 3) Bring AutomaticProductRule model in line with command layer.
ALTER TABLE "AutomaticProductRule"
  ADD COLUMN IF NOT EXISTS "name" TEXT,
  ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "commandVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "configFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "scheduleJson" JSONB,
  ADD COLUMN IF NOT EXISTS "targetMode" TEXT,
  ADD COLUMN IF NOT EXISTS "filterAstJson" JSONB,
  ADD COLUMN IF NOT EXISTS "savedTargetSetId" TEXT,
  ADD COLUMN IF NOT EXISTS "editOperationJson" JSONB,
  ADD COLUMN IF NOT EXISTS "safetyConfirmationJson" JSONB,
  ADD COLUMN IF NOT EXISTS "expectedPreviewFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pausedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "resumedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resumedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "schedulerDisabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "schedulerClaimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "schedulerClaimId" TEXT;

UPDATE "AutomaticProductRule"
SET "deletedAt" = COALESCE("deletedAt", NOW())
WHERE "status" = 'DELETED' AND "deletedAt" IS NULL;

-- 4) Bring AutomaticProductRuleRun model in line with command layer.
ALTER TABLE "AutomaticProductRuleRun"
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "ruleRevision" INTEGER,
  ADD COLUMN IF NOT EXISTS "configFingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "requestedByJson" JSONB,
  ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT,
  ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;

UPDATE "AutomaticProductRuleRun"
SET "idempotencyKey" = COALESCE("idempotencyKey", "executionKey")
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "AutomaticProductRuleRun"
  ALTER COLUMN "idempotencyKey" SET NOT NULL;

-- 5) Final composite indexes (scheduler/outbox/run focus).
CREATE INDEX IF NOT EXISTS "AutomaticProductRule_shop_deletedAt_idx" ON "AutomaticProductRule"("shop", "deletedAt");
CREATE INDEX IF NOT EXISTS "AutomaticProductRule_shop_status_deletedAt_idx" ON "AutomaticProductRule"("shop", "status", "deletedAt");
CREATE INDEX IF NOT EXISTS "AutomaticProductRule_shop_status_schedulerDisabledAt_idx" ON "AutomaticProductRule"("shop", "status", "schedulerDisabledAt");
CREATE INDEX IF NOT EXISTS "AutomaticProductRule_status_nextRunAt_idx" ON "AutomaticProductRule"("status", "nextRunAt");

CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_automaticProductRuleId_status_idx" ON "AutomaticProductRuleRun"("shop", "automaticProductRuleId", "status");
CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_automaticProductRuleId_createdAt_idx" ON "AutomaticProductRuleRun"("shop", "automaticProductRuleId", "createdAt");
CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_operationId_idx" ON "AutomaticProductRuleRun"("shop", "operationId");

CREATE INDEX IF NOT EXISTS "TargetFreezeCommand_shop_operationId_idx" ON "TargetFreezeCommand"("shop", "operationId");
CREATE INDEX IF NOT EXISTS "TargetFreezeCommand_status_createdAt_idx" ON "TargetFreezeCommand"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "OutboxEvent_shop_aggregateType_aggregateId_idx" ON "OutboxEvent"("shop", "aggregateType", "aggregateId");
