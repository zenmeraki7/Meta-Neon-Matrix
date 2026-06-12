import { db as repositoryDb } from "../repositories/repositoryDb.js";
import { guardedEditHistoryUpdate } from "./operationTransitionGuards.js";

const db = repositoryDb;

const DEFAULT_LEASE_MS = 10 * 60 * 1000;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeExecutionId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
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

async function writeStageWithCas({
  db = repositoryDb,
  historyId,
  shop,
  expectedExecutionStates = [],
  stage,
  expectedStageStatuses = [],
  expectedStageExecutionId = undefined,
  nextStageState,
  expectedExecutionIdentity = undefined,
} = {}) {
  const andClauses = [];
  if (Array.isArray(expectedStageStatuses) && expectedStageStatuses.length) {
    andClauses.push({
      OR: expectedStageStatuses.map((status) => ({
        batch: {
          path: ["idempotencyStages", stage, "status"],
          equals: status,
        },
      })),
    });
  }
  if (expectedStageExecutionId !== undefined) {
    andClauses.push({
      batch: {
        path: ["idempotencyStages", stage, "executionId"],
        equals: expectedStageExecutionId,
      },
    });
  }
  if (expectedExecutionIdentity !== undefined) {
    andClauses.push({
      executionIdentity: expectedExecutionIdentity,
    });
  }
  const extraWhere = andClauses.length ? { AND: andClauses } : {};
  return guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates,
    extraWhere,
    data: {
      batch: nextStageState,
    },
    db,
  });
}

export async function beginEditHistoryStage({
  historyId,
  shop,
  stage,
  executionId = null,
  leaseMs = DEFAULT_LEASE_MS,
  metadata = null,
  db = repositoryDb,
} = {}) {
  const normalizedExecutionId = normalizeExecutionId(executionId);
  const history = await db.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { id: true, executionIdentity: true, batch: true, executionState: true },
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
    executionId: normalizedExecutionId,
    metadata: metadata && typeof metadata === "object" ? metadata : existing.metadata || null,
    attempts: Number(existing.attempts || 0) + 1,
    recovered: existing.status === "running",
  };

  const expectedStageStatus = existing.status ?? null;
  const expectedExecutionId = normalizeExecutionId(existing.executionId);
  const casAnd = [];
  if (expectedExecutionId === null) {
    casAnd.push({
      batch: {
        path: ["idempotencyStages", stage, "executionId"],
        equals: null,
      },
    });
  } else {
    casAnd.push({
      batch: {
        path: ["idempotencyStages", stage, "executionId"],
        equals: expectedExecutionId,
      },
    });
  }
  const updated = await writeStageWithCas({
    db,
    historyId,
    shop,
    expectedExecutionStates: history.executionState ? [history.executionState] : [],
    stage,
    expectedStageStatuses: [expectedStageStatus],
    expectedStageExecutionId: expectedExecutionId,
    expectedExecutionIdentity: history.executionIdentity ?? null,
    nextStageState: buildNextBatchWithStage(batch, stage, nextStageState),
  });
  if (!updated) {
    return { state: "running", stageKey, operationId, stageState: existing };
  }

  return { state: "started", stageKey, operationId, stageState: nextStageState };
}

export async function completeEditHistoryStage({
  historyId,
  shop,
  stage,
  executionId = null,
  checkpoint = null,
  db = repositoryDb,
} = {}) {
  const normalizedExecutionId = normalizeExecutionId(executionId);
  const history = await db.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true, executionState: true, executionIdentity: true },
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
  await writeStageWithCas({
    db,
    historyId,
    shop,
    expectedExecutionStates: history.executionState ? [history.executionState] : [],
    stage,
    expectedStageStatuses: ["running"],
    expectedStageExecutionId: normalizedExecutionId ?? undefined,
    expectedExecutionIdentity: history.executionIdentity ?? null,
    nextStageState: buildNextBatchWithStage(batch, stage, nextStageState),
  });
}

export async function failEditHistoryStage({
  historyId,
  shop,
  stage,
  executionId = null,
  retryable = false,
  checkpoint = null,
  error = null,
  db = repositoryDb,
} = {}) {
  const normalizedExecutionId = normalizeExecutionId(executionId);
  const history = await db.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true, executionState: true, executionIdentity: true },
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
  await writeStageWithCas({
    db,
    historyId,
    shop,
    expectedExecutionStates: history.executionState ? [history.executionState] : [],
    stage,
    expectedStageStatuses: ["running", "retryable_failed"],
    expectedStageExecutionId: normalizedExecutionId ?? undefined,
    expectedExecutionIdentity: history.executionIdentity ?? null,
    nextStageState: buildNextBatchWithStage(batch, stage, nextStageState),
  });
}

