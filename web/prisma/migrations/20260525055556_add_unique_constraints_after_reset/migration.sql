/*
  Warnings:

  - The `status` column on the `AutomaticRuleApplication` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[shop,idempotencyKey]` on the table `AutomaticProductRuleRun` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[shop,editHistoryId,batchId,targetIdentity]` on the table `ChangeRecord` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `idempotencyKey` to the `AutomaticProductRuleRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `targetType` to the `AutomaticRuleApplication` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AutomaticRuleApplicationStatus" AS ENUM ('RESERVED', 'APPLIED', 'SKIPPED', 'FAILED', 'CANCELLED', 'UNKNOWN');

-- DropIndex
DROP INDEX "Store_accessTokenKeyVersion_idx";

-- DropIndex
DROP INDEX "TargetSnapshot_ownerType_ownerId_idx";

-- DropIndex
DROP INDEX "TargetSnapshot_ownerType_ownerId_productId_key";

-- DropIndex
DROP INDEX "TargetSnapshot_shop_ownerType_ownerId_productId_key";

-- DropIndex
DROP INDEX "TargetSnapshot_shop_ownerType_source_createdAt_idx";

-- DropIndex
DROP INDEX "TargetSnapshot_shop_owner_product_uq";

-- DropIndex
DROP INDEX "variant_barcode_trgm_idx";

-- DropIndex
DROP INDEX "variant_option1_value_trgm_idx";

-- DropIndex
DROP INDEX "variant_option2_value_trgm_idx";

-- DropIndex
DROP INDEX "variant_option3_value_trgm_idx";

-- DropIndex
DROP INDEX "variant_sku_trgm_idx";

-- AlterTable
ALTER TABLE "AutomaticProductRule" ADD COLUMN     "commandVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "configFingerprint" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "editOperationJson" JSONB,
ADD COLUMN     "expectedPreviewFingerprint" TEXT,
ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterAstJson" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedBy" TEXT,
ADD COLUMN     "resumedAt" TIMESTAMP(3),
ADD COLUMN     "resumedBy" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "safetyConfirmationJson" JSONB,
ADD COLUMN     "savedTargetSetId" TEXT,
ADD COLUMN     "scheduleJson" JSONB,
ADD COLUMN     "schedulerClaimId" TEXT,
ADD COLUMN     "schedulerClaimedAt" TIMESTAMP(3),
ADD COLUMN     "schedulerDisabledAt" TIMESTAMP(3),
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetMode" TEXT,
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "AutomaticProductRuleProductState" ALTER COLUMN "productId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AutomaticProductRuleRun" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledBy" TEXT,
ADD COLUMN     "configFingerprint" TEXT,
ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operationId" TEXT,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "requestedByJson" JSONB,
ADD COLUMN     "ruleRevision" INTEGER,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetResolvedAt" TIMESTAMP(3),
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "AutomaticRuleApplication" ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "productId" TEXT,
ADD COLUMN     "targetType" "AutomaticProductRuleTargetType" NOT NULL,
ADD COLUMN     "variantId" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" "AutomaticRuleApplicationStatus" NOT NULL DEFAULT 'RESERVED',
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "EditHistory" ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetResolvedAt" TIMESTAMP(3),
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "ExportJob" ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetResolvedAt" TIMESTAMP(3),
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "InventoryItemMirror" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Location" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "MirrorBatch" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PlanEntitlement" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ProductMediaMirror" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "RecurringEdit" ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "RecurringEditRun" ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetResolvedAt" TIMESTAMP(3),
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "ScheduledExport" ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "ScheduledExportRun" ADD COLUMN     "fieldRegistryVersion" TEXT,
ADD COLUMN     "filterAst" JSONB,
ADD COLUMN     "filterHash" TEXT,
ADD COLUMN     "normalizedFilterAst" JSONB,
ADD COLUMN     "operatorRegistryVersion" TEXT,
ADD COLUMN     "targetGranularity" TEXT,
ADD COLUMN     "targetResolvedAt" TIMESTAMP(3),
ADD COLUMN     "targetingCompilerVersion" TEXT,
ADD COLUMN     "targetingMode" TEXT,
ADD COLUMN     "targetingSnapshotMeta" JSONB;

-- AlterTable
ALTER TABLE "TargetSnapshot" ADD COLUMN     "targetGranularity" TEXT;

-- CreateTable
CREATE TABLE "TargetFreezeCommand" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operationId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceRevision" INTEGER,
    "configFingerprint" TEXT,
    "mirrorBatchId" TEXT,
    "targetMode" TEXT,
    "filterAstJson" JSONB,
    "savedTargetSetId" TEXT,
    "editOperationJson" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetFreezeCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadJson" JSONB,
    "status" TEXT NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkSubmission" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "editHistoryId" TEXT NOT NULL,
    "executionIdentity" TEXT,
    "batchId" TEXT,
    "operationName" TEXT NOT NULL,
    "mutationMode" TEXT NOT NULL,
    "stagedUploadPath" TEXT,
    "shopifyBulkOperationId" TEXT NOT NULL,
    "shopifyStatus" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationStageProgress" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "executionId" TEXT,
    "stageKey" TEXT NOT NULL,
    "stageStatus" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "counterA" INTEGER,
    "counterB" INTEGER,
    "counterC" INTEGER,
    "detail" JSONB,

    CONSTRAINT "OperationStageProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationEnqueueIntent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "queueKey" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "options" JSONB,
    "dedupeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationEnqueueIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TargetFreezeCommand_shop_operationId_idx" ON "TargetFreezeCommand"("shop", "operationId");

-- CreateIndex
CREATE INDEX "TargetFreezeCommand_status_createdAt_idx" ON "TargetFreezeCommand"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_shop_aggregateType_aggregateId_idx" ON "OutboxEvent"("shop", "aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "BulkSubmission_shop_editHistoryId_submittedAt_idx" ON "BulkSubmission"("shop", "editHistoryId", "submittedAt");

-- CreateIndex
CREATE INDEX "BulkSubmission_shop_executionIdentity_idx" ON "BulkSubmission"("shop", "executionIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "BulkSubmission_shop_shopifyBulkOperationId_key" ON "BulkSubmission"("shop", "shopifyBulkOperationId");

-- CreateIndex
CREATE INDEX "OperationStageProgress_shop_operationType_operationId_idx" ON "OperationStageProgress"("shop", "operationType", "operationId");

-- CreateIndex
CREATE INDEX "OperationStageProgress_shop_stageStatus_updatedAt_idx" ON "OperationStageProgress"("shop", "stageStatus", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_operation_stage_progress" ON "OperationStageProgress"("shop", "operationType", "operationId", "stageKey");

-- CreateIndex
CREATE INDEX "OperationEnqueueIntent_shop_status_runAt_idx" ON "OperationEnqueueIntent"("shop", "status", "runAt");

-- CreateIndex
CREATE INDEX "OperationEnqueueIntent_status_runAt_idx" ON "OperationEnqueueIntent"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperationEnqueueIntent_shop_queueKey_dedupeKey_key" ON "OperationEnqueueIntent"("shop", "queueKey", "dedupeKey");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_id_idx" ON "AutomaticProductRule"("shop", "id");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_isDeleted_idx" ON "AutomaticProductRule"("shop", "isDeleted");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_status_isDeleted_idx" ON "AutomaticProductRule"("shop", "status", "isDeleted");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_status_nextRunAt_idx" ON "AutomaticProductRule"("shop", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_deletedAt_idx" ON "AutomaticProductRule"("shop", "deletedAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_status_deletedAt_idx" ON "AutomaticProductRule"("shop", "status", "deletedAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_shop_status_schedulerDisabledAt_idx" ON "AutomaticProductRule"("shop", "status", "schedulerDisabledAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRule_status_nextRunAt_idx" ON "AutomaticProductRule"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleProductState_shop_lastRunId_idx" ON "AutomaticProductRuleProductState"("shop", "lastRunId");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleProductState_automaticProductRuleId_las_idx" ON "AutomaticProductRuleProductState"("automaticProductRuleId", "lastFingerprint");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleProductState_shop_automaticProductRuleI_idx" ON "AutomaticProductRuleProductState"("shop", "automaticProductRuleId", "lastFingerprint");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleRun_shop_automaticProductRuleId_status_idx" ON "AutomaticProductRuleRun"("shop", "automaticProductRuleId", "status");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleRun_shop_automaticProductRuleId_created_idx" ON "AutomaticProductRuleRun"("shop", "automaticProductRuleId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomaticProductRuleRun_shop_operationId_idx" ON "AutomaticProductRuleRun"("shop", "operationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomaticProductRuleRun_shop_idempotencyKey_key" ON "AutomaticProductRuleRun"("shop", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AutomaticRuleApplication_shop_targetType_productId_idx" ON "AutomaticRuleApplication"("shop", "targetType", "productId");

-- CreateIndex
CREATE INDEX "AutomaticRuleApplication_shop_targetType_variantId_idx" ON "AutomaticRuleApplication"("shop", "targetType", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "uniq_change_record_shop_history_batch_target" ON "ChangeRecord"("shop", "editHistoryId", "batchId", "targetIdentity");

-- CreateIndex
CREATE INDEX "EditHistory_shop_executionIdentity_idx" ON "EditHistory"("shop", "executionIdentity");

-- CreateIndex
CREATE INDEX "idx_targetsnapshot_owner" ON "TargetSnapshot"("shop", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "idx_targetsnapshot_owner_batch_type_ord" ON "TargetSnapshot"("shop", "ownerType", "ownerId", "mirrorBatchId", "targetType", "ordinal");

-- CreateIndex
CREATE INDEX "idx_targetsnapshot_owner_batch_ord" ON "TargetSnapshot"("shop", "ownerType", "ownerId", "mirrorBatchId", "ordinal");

-- RenameIndex
ALTER INDEX "AutomaticRuleState_rule_targetType_idx" RENAME TO "AutomaticProductRuleProductState_automaticProductRuleId_tar_idx";

-- RenameIndex
ALTER INDEX "AutomaticRuleState_shop_batch_idx" RENAME TO "AutomaticProductRuleProductState_shop_lastMirrorBatchId_idx";

-- RenameIndex
ALTER INDEX "AutomaticRuleState_shop_targetType_product_idx" RENAME TO "AutomaticProductRuleProductState_shop_targetType_productId_idx";

-- RenameIndex
ALTER INDEX "AutomaticRuleState_shop_targetType_variant_idx" RENAME TO "AutomaticProductRuleProductState_shop_targetType_variantId_idx";

-- RenameIndex
ALTER INDEX "AutomaticProductRuleRun_automaticProductRuleId_status_createdAt" RENAME TO "AutomaticProductRuleRun_automaticProductRuleId_status_creat_idx";

-- RenameIndex
ALTER INDEX "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueBoolean_i" RENAME TO "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueBoole_idx";

-- RenameIndex
ALTER INDEX "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueNumber_id" RENAME TO "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueNumbe_idx";

-- RenameIndex
ALTER INDEX "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueTextNorma" RENAME TO "MetafieldMirror_shop_mirrorBatchId_namespace_key_valueTextN_idx";

-- RenameIndex
ALTER INDEX "TargetSnapshot_shop_batch_targetType_idx" RENAME TO "idx_targetsnapshot_batch_type";

-- RenameIndex
ALTER INDEX "TargetSnapshot_shop_ownerType_createdAt_idx" RENAME TO "idx_targetsnapshot_owner_created";

-- RenameIndex
ALTER INDEX "TargetSnapshot_shop_owner_batch_filterhash_type_ordinal_idx" RENAME TO "idx_targetsnapshot_owner_batch_hash_type_ord";

-- RenameIndex
ALTER INDEX "TargetSnapshot_shop_owner_owner_batch_idx" RENAME TO "idx_targetsnapshot_owner_batch";

-- RenameIndex
ALTER INDEX "TargetSnapshot_shop_owner_owner_batch_type_ordinal_id_idx" RENAME TO "idx_targetsnapshot_owner_batch_type_ord_id";

-- RenameIndex
ALTER INDEX "TargetSnapshot_shop_productId_idx" RENAME TO "idx_targetsnapshot_shop_product";

-- RenameIndex
ALTER INDEX "TargetSnapshot_shop_variantId_idx" RENAME TO "idx_targetsnapshot_shop_variant";
