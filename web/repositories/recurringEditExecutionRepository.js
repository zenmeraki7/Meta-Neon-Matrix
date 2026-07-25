import { prisma } from "../config/database.js";
import { recurringEditRunRepository } from "./recurringEditRunRepository.js";
import { normalizeEditHistoryExecutionState } from "../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../services/operationLifecycleStateMachine.js";

export async function withRecurringExecutionTransaction(fn) {
  return prisma.$transaction(fn);
}

export async function tryTransactionAdvisoryLock(db, lockKey) {
  const rows = await db.$queryRaw`
    SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function createRecurringEditHistoryAndLinkRun({
  tx,
  baseHistory,
  currentRecurringEdit,
  recurringEditRunId,
  localizedTitle,
  compilerVersions,
}) {
  const mergedBatch = {
    ...(baseHistory.batch && typeof baseHistory.batch === "object" ? baseHistory.batch : {}),
    filterAst: currentRecurringEdit.filterAst ?? null,
    rawFilterInput: Array.isArray(currentRecurringEdit.rawFilterInput)
      ? currentRecurringEdit.rawFilterInput
      : [],
    targetGranularity: currentRecurringEdit.targetGranularity || "PRODUCT",
    targetFreezeMode: "DYNAMIC_AT_RUN",
    freezeMode: "DYNAMIC_AT_RUN",
  };
  const editHistory = await tx.editHistory.create({
    data: {
      ...baseHistory,
      batch: mergedBatch,
      targetSnapshotCount: 0,
      totalItems: 0,
      targetProductMirrorBatchId: null,
      title: localizedTitle,
      type: "Recurring edit",
      isRecurring: true,
      recurringEditId: currentRecurringEdit.id,
      recurringRunId: recurringEditRunId,
      triggerType: "RECURRING",
      executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    },
  });

  await recurringEditRunRepository.updateById(recurringEditRunId, {
    editHistoryId: editHistory.id,
    mirrorBatchId: null,
    filterAst: currentRecurringEdit.filterAst ?? null,
    normalizedFilterAst: currentRecurringEdit.normalizedFilterAst ?? null,
    targetingSnapshotMeta: {
      ...(currentRecurringEdit.targetingSnapshotMeta || {}),
      createdCompilerVersion:
        compilerVersions.createdCompilerVersion || currentRecurringEdit.targetingCompilerVersion || null,
      currentCompilerVersion: compilerVersions.currentCompilerVersion,
      source: "RECURRING",
      semantics: "DYNAMIC_AT_RUN",
      recurringEditRunId,
      recurringEditId: currentRecurringEdit.id,
      resolvedAt: null,
    },
    targetFreezeMode: "DYNAMIC_AT_RUN",
    targetGranularity: currentRecurringEdit.targetGranularity || "PRODUCT",
    targetingCompilerVersion: compilerVersions.currentCompilerVersion,
    fieldRegistryVersion: currentRecurringEdit.fieldRegistryVersion || null,
    operatorRegistryVersion: currentRecurringEdit.operatorRegistryVersion || null,
    normalizedFilterHash: currentRecurringEdit.normalizedFilterHash || null,
    targetResolvedAt: null,
  }, tx);

  return {
    editHistoryId: editHistory.id,
    executionIdentity: editHistory.executionIdentity,
  };
}

export async function markEditHistoryQueuedIfFrozen(editHistoryId, shop) {
  return prisma.editHistory.updateMany({
    where: {
      id: editHistoryId,
      shop,
      executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
    },
    data: {
      executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.QUEUED,
      ),
    },
  });
}

export async function findHistoryForRecurringFinalize(historyId) {
  return prisma.editHistory.findUnique({
    where: { id: historyId },
    select: {
      recurringRunId: true,
      recurringEditId: true,
      completedAt: true,
      status: true,
      shop: true,
    },
  });
}
