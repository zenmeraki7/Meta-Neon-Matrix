import { prisma } from "../config/database.js";

const DEFAULT_LEASE_MS = 10 * 60 * 1000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nowIso() {
  return new Date().toISOString();
}

function buildStageKey(shop, operationId, stage) {
  return `${shop}:${operationId}:${stage}`;
}

function buildNextBatchWithStage(batch, stage, nextStageState) {
  const currentBatch = asObject(batch);
  const idempotencyStages = asObject(currentBatch.idempotencyStages);
  return {
    ...currentBatch,
    idempotencyStages: {
      ...idempotencyStages,
      [stage]: nextStageState,
    },
  };
}

export async function beginEditHistoryStage({
  historyId,
  shop,
  stage,
  executionId = null,
  leaseMs = DEFAULT_LEASE_MS,
  metadata = null,
} = {}) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { id: true, executionIdentity: true, batch: true },
  });
  if (!history) {
    throw new Error("EDIT_HISTORY_NOT_FOUND");
  }

  const operationId = String(history.executionIdentity || history.id);
  const stageKey = buildStageKey(shop, operationId, stage);
  const batch = asObject(history.batch);
  const idempotencyStages = asObject(batch.idempotencyStages);
  const existing = asObject(idempotencyStages[stage]);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + Math.max(30_000, Number(leaseMs || DEFAULT_LEASE_MS)));

  if (existing.status === "completed") {
    return { state: "completed", stageKey, operationId, stageState: existing };
  }

  if (existing.status === "running" && existing.leaseUntil) {
    const existingLease = new Date(existing.leaseUntil);
    if (existingLease > now) {
      return { state: "running", stageKey, operationId, stageState: existing };
    }
  }

  const nextStageState = {
    key: stageKey,
    stage,
    status: "running",
    startedAt: existing.startedAt || nowIso(),
    updatedAt: nowIso(),
    leaseUntil: leaseUntil.toISOString(),
    executionId: executionId || null,
    metadata: metadata && typeof metadata === "object" ? metadata : existing.metadata || null,
    attempts: Number(existing.attempts || 0) + 1,
    recovered: existing.status === "running",
  };

  await prisma.editHistory.update({
    where: { id: historyId },
    data: {
      batch: buildNextBatchWithStage(batch, stage, nextStageState),
    },
  });

  return { state: "started", stageKey, operationId, stageState: nextStageState };
}

export async function completeEditHistoryStage({
  historyId,
  shop,
  stage,
  checkpoint = null,
} = {}) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });
  if (!history) return;
  const batch = asObject(history.batch);
  const idempotencyStages = asObject(batch.idempotencyStages);
  const existing = asObject(idempotencyStages[stage]);
  const nextStageState = {
    ...existing,
    status: "completed",
    completedAt: nowIso(),
    updatedAt: nowIso(),
    leaseUntil: null,
    checkpoint: checkpoint ?? existing.checkpoint ?? null,
  };
  await prisma.editHistory.update({
    where: { id: historyId },
    data: {
      batch: buildNextBatchWithStage(batch, stage, nextStageState),
    },
  });
}

export async function failEditHistoryStage({
  historyId,
  shop,
  stage,
  retryable = false,
  checkpoint = null,
  error = null,
} = {}) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });
  if (!history) return;
  const batch = asObject(history.batch);
  const idempotencyStages = asObject(batch.idempotencyStages);
  const existing = asObject(idempotencyStages[stage]);
  const nextStageState = {
    ...existing,
    status: retryable ? "retryable_failed" : "failed",
    updatedAt: nowIso(),
    leaseUntil: null,
    checkpoint: checkpoint ?? existing.checkpoint ?? null,
    error: error ? String(error) : existing.error || null,
  };
  await prisma.editHistory.update({
    where: { id: historyId },
    data: {
      batch: buildNextBatchWithStage(batch, stage, nextStageState),
    },
  });
}
