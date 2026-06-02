import { db } from "../repositories/repositoryDb.js";

export async function upsertOperationStageProgress({
  shop,
  operationType,
  operationId,
  executionId = null,
  stageKey,
  stageStatus,
  counterA = null,
  counterB = null,
  counterC = null,
  detail = null,
  completed = false,
}) {
  if (!shop || !operationType || !operationId || !stageKey || !stageStatus) {
    return;
  }

  const where = {
    shop_operationType_operationId_stageKey: {
      shop,
      operationType,
      operationId,
      stageKey,
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
      stageKey,
      startedAt: new Date(),
      ...base,
    },
    update: base,
  });
}


