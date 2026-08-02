import { db } from "../repositories/repositoryDb.js";

function nonNegativeCount(value, fieldName) {
  if (value === null || value === undefined) return null;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
  return count;
}

export async function upsertOperationStageProgress({
  shop,
  operationType,
  operationId,
  executionId = null,
  workflowStageKey,
  stageStatus,
  succeededItemCount = null,
  failedItemCount = null,
  observedItemCount = null,
  detail = null,
  completed = false,
}) {
  if (!shop || !operationType || !operationId || !workflowStageKey || !stageStatus) {
    return;
  }

  const where = {
    shop_operationType_operationId_workflowStageKey: {
      shop,
      operationType,
      operationId,
      workflowStageKey,
    },
  };

  const base = {
    executionId,
    stageStatus,
    succeededItemCount: nonNegativeCount(succeededItemCount, "succeededItemCount"),
    failedItemCount: nonNegativeCount(failedItemCount, "failedItemCount"),
    observedItemCount: nonNegativeCount(observedItemCount, "observedItemCount"),
    detail,
    ...(completed ? { completedAt: new Date() } : {}),
  };

  await db.operationStageProgress.upsert({
    where,
    create: {
      shop,
      operationType,
      operationId,
      workflowStageKey,
      startedAt: new Date(),
      ...base,
    },
    update: base,
  });
}
