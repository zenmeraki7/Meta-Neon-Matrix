/*
  Warnings:

  - The `edit_status` column on the `variant_metafields` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "EditStatus" AS ENUM ('SYNCED', 'PENDING', 'WRITING', 'WRITTEN', 'ERROR');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('DRAFT', 'COMMITTED', 'WRITING', 'DONE', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('PENDING', 'WRITING', 'WRITTEN', 'ERROR');

-- CreateEnum
CREATE TYPE "TargetSnapshotSetStatus" AS ENUM ('FREEZING', 'FROZEN', 'FREEZE_FAILED', 'EXPIRED', 'CANCELLED', 'CORRUPTED');

-- CreateEnum
CREATE TYPE "TargetSnapshotTargetType" AS ENUM ('PRODUCT', 'VARIANT', 'INVENTORY_ITEM', 'METAFIELD');

-- CreateEnum
CREATE TYPE "TargetSnapshotItemExecutionStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'VERIFIED');

-- CreateEnum
CREATE TYPE "TargetSnapshotItemUndoStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- DropIndex
DROP INDEX "UndoConflictChunk_operation_idx";

-- DropIndex
DROP INDEX "UndoConflictChunk_type_idx";

-- DropIndex
DROP INDEX "WebhookDelivery_shop_entityId_createdAt_idx";

-- DropIndex
DROP INDEX "dead_letter_changes_shop_failed_idx";

-- AlterTable
ALTER TABLE "EditHistory" ADD COLUMN     "snapshotSetId" TEXT;

-- AlterTable
ALTER TABLE "dead_letter_changes" ALTER COLUMN "failed_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "variant_metafields" DROP COLUMN "edit_status",
ADD COLUMN     "edit_status" "EditStatus" NOT NULL DEFAULT 'SYNCED';

-- CreateTable
CREATE TABLE "bulk_edit_sessions" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_edit_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_edit_changes" (
    "id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "variant_metafield_id" BIGINT NOT NULL,
    "new_value" TEXT NOT NULL,
    "compare_digest" TEXT NOT NULL,
    "status" "ChangeStatus" NOT NULL DEFAULT 'PENDING',
    "error_code" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_edit_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "cursor_value" TEXT,
    "last_synced_at" TIMESTAMP(3),

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetSnapshotSet" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "previewContractId" TEXT NOT NULL,
    "mirrorBatchId" TEXT NOT NULL,
    "targetingFingerprint" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL DEFAULT 0,
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "submittedCount" INTEGER NOT NULL DEFAULT 0,
    "succeededCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "verifiedCount" INTEGER NOT NULL DEFAULT 0,
    "undoPendingCount" INTEGER NOT NULL DEFAULT 0,
    "undoSucceededCount" INTEGER NOT NULL DEFAULT 0,
    "undoFailedCount" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "compilerVersion" TEXT NOT NULL,
    "projectionVersion" TEXT NOT NULL,
    "plannerVersion" TEXT,
    "status" "TargetSnapshotSetStatus" NOT NULL DEFAULT 'FREEZING',
    "freezeErrorCode" TEXT,
    "freezeErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "TargetSnapshotSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetSnapshotItem" (
    "id" TEXT NOT NULL,
    "snapshotSetId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "mirrorBatchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "targetKey" TEXT NOT NULL,
    "targetType" "TargetSnapshotTargetType" NOT NULL,
    "mutationGroupKey" TEXT,
    "beforeValues" JSONB NOT NULL,
    "plannedMutation" JSONB NOT NULL,
    "targetFingerprint" TEXT NOT NULL,
    "rowChecksum" TEXT NOT NULL,
    "executionStatus" "TargetSnapshotItemExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "executionAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastExecutionAttemptAt" TIMESTAMP(3),
    "shopifyBulkLineNumber" INTEGER,
    "shopifyResultId" TEXT,
    "shopifyErrorCode" TEXT,
    "shopifyErrorMessage" TEXT,
    "undoStatus" "TargetSnapshotItemUndoStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "undoAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastUndoAttemptAt" TIMESTAMP(3),
    "undoPayload" JSONB,
    "undoErrorCode" TEXT,
    "undoErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "undoSubmittedAt" TIMESTAMP(3),
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "TargetSnapshotItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bulk_edit_changes_session_id_status_idx" ON "bulk_edit_changes"("session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_edit_changes_session_id_variant_metafield_id_key" ON "bulk_edit_changes"("session_id", "variant_metafield_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_cursors_shop_id_resource_type_key" ON "sync_cursors"("shop_id", "resource_type");

-- CreateIndex
CREATE INDEX "TargetSnapshotSet_shop_previewContractId_idx" ON "TargetSnapshotSet"("shop", "previewContractId");

-- CreateIndex
CREATE INDEX "TargetSnapshotSet_shop_mirrorBatchId_targetingFingerprint_idx" ON "TargetSnapshotSet"("shop", "mirrorBatchId", "targetingFingerprint");

-- CreateIndex
CREATE INDEX "TargetSnapshotSet_shop_status_idx" ON "TargetSnapshotSet"("shop", "status");

-- CreateIndex
CREATE INDEX "TargetSnapshotSet_shop_operationId_status_idx" ON "TargetSnapshotSet"("shop", "operationId", "status");

-- CreateIndex
CREATE INDEX "TargetSnapshotSet_shop_createdAt_idx" ON "TargetSnapshotSet"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "TargetSnapshotSet_shop_expiresAt_idx" ON "TargetSnapshotSet"("shop", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TargetSnapshotSet_shop_operationId_key" ON "TargetSnapshotSet"("shop", "operationId");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_snapshotSetId_idx" ON "TargetSnapshotItem"("shop", "snapshotSetId");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_operationId_idx" ON "TargetSnapshotItem"("shop", "operationId");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_operationId_executionStatus_idx" ON "TargetSnapshotItem"("shop", "operationId", "executionStatus");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_operationId_undoStatus_idx" ON "TargetSnapshotItem"("shop", "operationId", "undoStatus");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_snapshotSetId_executionStatus_idx" ON "TargetSnapshotItem"("shop", "snapshotSetId", "executionStatus");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_snapshotSetId_undoStatus_idx" ON "TargetSnapshotItem"("shop", "snapshotSetId", "undoStatus");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_snapshotSetId_mutationGroupKey_idx" ON "TargetSnapshotItem"("shop", "snapshotSetId", "mutationGroupKey");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_mirrorBatchId_idx" ON "TargetSnapshotItem"("shop", "mirrorBatchId");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_productId_idx" ON "TargetSnapshotItem"("shop", "productId");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_shop_variantId_idx" ON "TargetSnapshotItem"("shop", "variantId");

-- CreateIndex
CREATE INDEX "TargetSnapshotItem_snapshotSetId_targetType_idx" ON "TargetSnapshotItem"("snapshotSetId", "targetType");

-- CreateIndex
CREATE UNIQUE INDEX "TargetSnapshotItem_snapshotSetId_targetKey_key" ON "TargetSnapshotItem"("snapshotSetId", "targetKey");

-- CreateIndex
CREATE INDEX "EditHistory_shop_snapshotSetId_idx" ON "EditHistory"("shop", "snapshotSetId");

-- CreateIndex
CREATE INDEX "UndoOperationConflictChunk_shop_undoOperationId_chunkType_c_idx" ON "UndoOperationConflictChunk"("shop", "undoOperationId", "chunkType", "chunkIndex");

-- CreateIndex
CREATE INDEX "dead_letter_changes_shop_id_failed_at_idx" ON "dead_letter_changes"("shop_id", "failed_at");

-- RenameForeignKey
ALTER TABLE "BulkEditRecoveryAudit" RENAME CONSTRAINT "RecoveryAudit_history_fkey" TO "BulkEditRecoveryAudit_historyId_fkey";

-- RenameForeignKey
ALTER TABLE "UndoOperation" RENAME CONSTRAINT "UndoOperation_sourceHistory_fkey" TO "UndoOperation_sourceEditHistoryId_fkey";

-- RenameForeignKey
ALTER TABLE "UndoOperationConflictChunk" RENAME CONSTRAINT "UndoConflictChunk_operation_fkey" TO "UndoOperationConflictChunk_undoOperationId_fkey";

-- AddForeignKey
ALTER TABLE "bulk_edit_sessions" ADD CONSTRAINT "bulk_edit_sessions_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_edit_changes" ADD CONSTRAINT "bulk_edit_changes_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "bulk_edit_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_edit_changes" ADD CONSTRAINT "bulk_edit_changes_variant_metafield_id_fkey" FOREIGN KEY ("variant_metafield_id") REFERENCES "variant_metafields"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditHistory" ADD CONSTRAINT "EditHistory_snapshotSetId_fkey" FOREIGN KEY ("snapshotSetId") REFERENCES "TargetSnapshotSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetSnapshotItem" ADD CONSTRAINT "TargetSnapshotItem_snapshotSetId_fkey" FOREIGN KEY ("snapshotSetId") REFERENCES "TargetSnapshotSet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "RecoveryAudit_shop_history_createdAt_idx" RENAME TO "BulkEditRecoveryAudit_shop_historyId_createdAt_idx";

-- RenameIndex
ALTER INDEX "EditHistoryIngestionCheckpoint_shop_historyId_ingestionRunId_ke" RENAME TO "EditHistoryIngestionCheckpoint_shop_historyId_ingestionRunI_key";

-- RenameIndex
ALTER INDEX "EditHistoryIngestionCheckpoint_shop_historyId_status_updatedAt_" RENAME TO "EditHistoryIngestionCheckpoint_shop_historyId_status_update_idx";

-- RenameIndex
ALTER INDEX "UndoOperation_shop_sourceHistory_key" RENAME TO "UndoOperation_shop_sourceEditHistoryId_key";

-- RenameIndex
ALTER INDEX "UndoConflictChunk_unique_chunk" RENAME TO "UndoOperationConflictChunk_shop_undoOperationId_chunkType_c_key";

-- RenameIndex
ALTER INDEX "variant_metafields_shop_dirty_idx" RENAME TO "variant_metafields_shop_id_is_dirty_idx";

-- RenameIndex
ALTER INDEX "variant_metafields_shop_variant_namespace_key" RENAME TO "variant_metafields_shop_id_variant_id_namespace_key_key";

-- RenameIndex
ALTER INDEX "variant_metafields_variant_key_idx" RENAME TO "variant_metafields_variant_id_namespace_key_idx";
