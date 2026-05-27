ALTER TABLE "EditHistory"
  ADD COLUMN IF NOT EXISTS "entitlementSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "actorType" TEXT,
  ADD COLUMN IF NOT EXISTS "actorId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "actorName" TEXT;

ALTER TABLE "RecurringEdit"
  ADD COLUMN IF NOT EXISTS "actorType" TEXT,
  ADD COLUMN IF NOT EXISTS "actorId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "actorName" TEXT;

ALTER TABLE "RecurringEditRun"
  ADD COLUMN IF NOT EXISTS "mirrorBatchId" TEXT;
CREATE INDEX IF NOT EXISTS "RecurringEditRun_shop_mirrorBatchId_idx"
  ON "RecurringEditRun"("shop", "mirrorBatchId");

ALTER TABLE "AutomaticProductRule"
  ADD COLUMN IF NOT EXISTS "actorType" TEXT,
  ADD COLUMN IF NOT EXISTS "actorId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "actorName" TEXT;

ALTER TABLE "AutomaticProductRuleRun"
  ADD COLUMN IF NOT EXISTS "mirrorBatchId" TEXT;
CREATE INDEX IF NOT EXISTS "AutomaticProductRuleRun_shop_mirrorBatchId_idx"
  ON "AutomaticProductRuleRun"("shop", "mirrorBatchId");

ALTER TABLE "AutomaticProductRuleProductState"
  ADD COLUMN IF NOT EXISTS "targetType" TEXT,
  ADD COLUMN IF NOT EXISTS "variantId" TEXT,
  ADD COLUMN IF NOT EXISTS "targetIdentity" TEXT;

UPDATE "AutomaticProductRuleProductState"
SET "targetType" = COALESCE("targetType", 'PRODUCT')
WHERE "targetType" IS NULL;

UPDATE "AutomaticProductRuleProductState"
SET "targetIdentity" = COALESCE("targetIdentity", CONCAT('PRODUCT:', "productId"))
WHERE "targetIdentity" IS NULL;

ALTER TABLE "AutomaticProductRuleProductState"
  ALTER COLUMN "targetType" SET DEFAULT 'PRODUCT',
  ALTER COLUMN "targetType" SET NOT NULL,
  ALTER COLUMN "targetIdentity" SET NOT NULL;

DROP INDEX IF EXISTS "AutomaticProductRuleProductState_automaticProductRuleId_shop_productId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticProductRuleProductState_automaticProductRuleId_shop_targetIdentity_key"
  ON "AutomaticProductRuleProductState"("automaticProductRuleId", "shop", "targetIdentity");

CREATE INDEX IF NOT EXISTS "AutomaticProductRuleProductState_shop_variantId_idx"
  ON "AutomaticProductRuleProductState"("shop", "variantId");

CREATE TABLE IF NOT EXISTS "AutomaticRuleApplication" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "ruleId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "targetIdentity" TEXT NOT NULL,
  "triggerReference" TEXT,
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AutomaticRuleApplication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AutomaticRuleApplication_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomaticProductRule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticRuleApplication_shop_ruleId_fingerprint_key"
  ON "AutomaticRuleApplication"("shop", "ruleId", "fingerprint");
CREATE INDEX IF NOT EXISTS "AutomaticRuleApplication_shop_runId_idx"
  ON "AutomaticRuleApplication"("shop", "runId");
CREATE INDEX IF NOT EXISTS "AutomaticRuleApplication_shop_targetIdentity_idx"
  ON "AutomaticRuleApplication"("shop", "targetIdentity");

ALTER TABLE "ProductCodeSnippet"
  ADD COLUMN IF NOT EXISTS "actorType" TEXT,
  ADD COLUMN IF NOT EXISTS "actorId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "actorName" TEXT;

ALTER TABLE "ScheduledExportRun"
  ADD COLUMN IF NOT EXISTS "targetMirrorBatchId" TEXT;
CREATE INDEX IF NOT EXISTS "ScheduledExportRun_shop_targetMirrorBatchId_idx"
  ON "ScheduledExportRun"("shop", "targetMirrorBatchId");

ALTER TABLE "ExportJob"
  ADD COLUMN IF NOT EXISTS "entitlementSnapshot" JSONB,
  ADD COLUMN IF NOT EXISTS "actorType" TEXT,
  ADD COLUMN IF NOT EXISTS "actorId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "actorName" TEXT;

ALTER TABLE "OperationFingerprint"
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "OperationFingerprint_shop_operationType_status_createdAt_idx"
  ON "OperationFingerprint"("shop", "operationType", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "OperationFingerprint_expiresAt_idx"
  ON "OperationFingerprint"("expiresAt");

CREATE TABLE IF NOT EXISTS "PlanEntitlement" (
  "planKey" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlanEntitlement_pkey" PRIMARY KEY ("planKey", "key")
);

CREATE TABLE IF NOT EXISTS "BillingEvent" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BillingEvent_shop_createdAt_idx"
  ON "BillingEvent"("shop", "createdAt");
CREATE INDEX IF NOT EXISTS "BillingEvent_shop_eventType_createdAt_idx"
  ON "BillingEvent"("shop", "eventType", "createdAt");

CREATE TABLE IF NOT EXISTS "OperationLease" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "fencingToken" BIGINT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "OperationLease_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OperationLease_shop_namespace_resourceId_key"
  ON "OperationLease"("shop", "namespace", "resourceId");
CREATE INDEX IF NOT EXISTS "OperationLease_expiresAt_idx"
  ON "OperationLease"("expiresAt");
CREATE INDEX IF NOT EXISTS "OperationLease_shop_namespace_idx"
  ON "OperationLease"("shop", "namespace");

CREATE TABLE IF NOT EXISTS "DeadLetterJob" (
  "id" TEXT NOT NULL,
  "shop" TEXT,
  "queueName" TEXT NOT NULL,
  "jobName" TEXT,
  "jobId" TEXT,
  "payload" JSONB,
  "error" TEXT,
  "attempts" INTEGER NOT NULL,
  "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolution" TEXT,
  CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "DeadLetterJob_shop_failedAt_idx"
  ON "DeadLetterJob"("shop", "failedAt");
CREATE INDEX IF NOT EXISTS "DeadLetterJob_queueName_failedAt_idx"
  ON "DeadLetterJob"("queueName", "failedAt");
CREATE INDEX IF NOT EXISTS "DeadLetterJob_resolvedAt_idx"
  ON "DeadLetterJob"("resolvedAt");
