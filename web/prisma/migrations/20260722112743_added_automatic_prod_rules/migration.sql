-- CreateEnum
CREATE TYPE "AutomaticProductRuleStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutomaticProductRuleTriggerType" AS ENUM ('EVENT', 'SCHEDULED', 'HYBRID');

-- CreateEnum
CREATE TYPE "AutomaticRuleScheduleType" AS ENUM ('CRON', 'DAILY', 'WEEKLY', 'MONTHLY', 'EVERY_X_MINUTES');

-- CreateEnum
CREATE TYPE "AutomaticProductRuleScopeType" AS ENUM ('PRODUCT', 'VARIANT');

-- CreateEnum
CREATE TYPE "AutomaticProductRuleRunStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AutomaticProductRuleRunTriggerSource" AS ENUM ('SCHEDULE', 'WEBHOOK', 'MANUAL', 'REINDEX');

-- CreateTable
CREATE TABLE "AutomaticProductRule" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AutomaticProductRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "triggerType" "AutomaticProductRuleTriggerType" NOT NULL,
    "scheduleType" "AutomaticRuleScheduleType",
    "timezone" TEXT,
    "scheduleConfig" JSONB,
    "cronExpression" TEXT,
    "intervalMinutes" INTEGER,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "scopeType" "AutomaticProductRuleScopeType" NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "applyMode" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "cooldownMinutes" INTEGER,
    "maxAffectedPerRun" INTEGER,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureReason" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "filterVersion" INTEGER NOT NULL DEFAULT 1,
    "canonicalFilterKey" TEXT,

    CONSTRAINT "AutomaticProductRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomaticProductRuleRun" (
    "id" TEXT NOT NULL,
    "automaticProductRuleId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "triggerSource" "AutomaticProductRuleRunTriggerSource" NOT NULL,
    "triggerReference" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" "AutomaticProductRuleRunStatus" NOT NULL DEFAULT 'PENDING',
    "executionKey" TEXT NOT NULL,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "editHistoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomaticProductRuleRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomaticProductRuleProductState" (
    "id" TEXT NOT NULL,
    "automaticProductRuleId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lastMatchedAt" TIMESTAMP(3),
    "lastAppliedAt" TIMESTAMP(3),
    "lastFingerprint" TEXT,
    "suppressedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomaticProductRuleProductState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_status_idx" ON "AutomaticProductRule"("shop", "status");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_nextRunAt_idx" ON "AutomaticProductRule"("shop", "nextRunAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_triggerType_idx" ON "AutomaticProductRule"("shop", "triggerType");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_priority_status_idx" ON "AutomaticProductRule"("shop", "priority", "status");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_createdAt_idx" ON "AutomaticProductRule"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_canonicalFilterKey_idx" ON "AutomaticProductRule"("shop", "canonicalFilterKey");

-- CreateIndex
CREATE UNIQUE INDEX "AutomaticProductRuleRun_executionKey_key" ON "AutomaticProductRuleRun"("executionKey");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleRun_shop_status_createdAt_idx" ON "AutomaticProductRuleRun"("shop", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleRun_automaticProductRuleId_createdAt_idx" ON "AutomaticProductRuleRun"("automaticProductRuleId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleRun_automaticProductRuleId_scheduledFor_idx" ON "AutomaticProductRuleRun"("automaticProductRuleId", "scheduledFor");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleRun_editHistoryId_idx" ON "AutomaticProductRuleRun"("editHistoryId");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleProductState_shop_productId_idx" ON "AutomaticProductRuleProductState"("shop", "productId");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleProductState_automaticProductRuleId_sup_idx" ON "AutomaticProductRuleProductState"("automaticProductRuleId", "suppressedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AutomaticProductRuleProductState_automaticProductRuleId_sho_key" ON "AutomaticProductRuleProductState"("automaticProductRuleId", "shop", "productId");

-- AddForeignKey
ALTER TABLE "AutomaticProductRuleRun" ADD CONSTRAINT "AutomaticProductRuleRun_automaticProductRuleId_fkey" FOREIGN KEY ("automaticProductRuleId") REFERENCES "AutomaticProductRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomaticProductRuleProductState" ADD CONSTRAINT "AutomaticProductRuleProductState_automaticProductRuleId_fkey" FOREIGN KEY ("automaticProductRuleId") REFERENCES "AutomaticProductRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
