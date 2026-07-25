import { db } from "../repositories/repositoryDb.js";

export async function upsertOperationStageProgress({
  shop,
  operationType,
  operationId,
  executionId = null,
  workflowStageKey,
  stageStatus,
  counterA = null,
  counterB = null,
  counterC = null,
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
    counterA,
    counterB,
    counterC,
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


