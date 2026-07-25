import { prisma } from "../config/database.js";
import { normalizeExportJobExecutionState } from "../utils/normalizedStateUtils.js";

export async function withScheduledExportExecutionTransaction(fn, options = {}) {
  return prisma.$transaction(async (tx) => fn(tx), options);
}

export async function tryAdvisoryLockTx(tx, lockKey) {
  const rows = await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function tryAdvisoryLockSession(lockKey) {
  const rows = await prisma.$queryRaw`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function unlockAdvisoryLockSession(lockKey) {
  await prisma.$queryRaw`
    SELECT pg_advisory_unlock(hashtext(${lockKey}))
  `;
}

export async function findExportJobByScheduledRun(shop, scheduledExportRunId, db = prisma) {
  return db.exportJob.findFirst({
    where: {
      shop,
      scheduledExportRunId,
    },
    select: { id: true },
  });
}

export async function findExportJobForRunFinalize(exportJobId, db = prisma) {
  return db.exportJob.findUnique({
    where: { id: exportJobId },
    select: {
      scheduledExportId: true,
      scheduledExportRunId: true,
      downloadUrl: true,
      totalItems: true,
      durationMs: true,
      completedAt: true,
      status: true,
      error: true,
      shop: true,
      generatedFilename: true,
    },
  });
}

export async function createScheduledExportJob(data, db = prisma) {
  return db.exportJob.create({ data });
}

export async function findExportJobById(id, db = prisma) {
  return db.exportJob.findUnique({ where: { id } });
}

export async function markExportJobTargetFrozen({
  exportJobId,
  shop,
  expectedExecutionState,
  frozenCount,
}, db = prisma) {
  return db.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      executionStateNormalized: normalizeExportJobExecutionState(expectedExecutionState),
    },
    data: {
      targetSnapshotCount: frozenCount,
      executionState: expectedExecutionState,
      executionStateNormalized: normalizeExportJobExecutionState(expectedExecutionState),
    },
  });
}

export async function markExportJobQueued({
  exportJobId,
  shop,
  expectedExecutionState,
  queuedExecutionState,
  executionStateNormalized,
}, db = prisma) {
  const data = {
    executionState: queuedExecutionState,
  };
  if (executionStateNormalized !== null && executionStateNormalized !== undefined) {
    data.executionStateNormalized = executionStateNormalized;
  }
  return db.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      executionStateNormalized: normalizeExportJobExecutionState(expectedExecutionState),
    },
    data,
  });
}

export async function findExportHistoryByScheduledTask(shop, scheduledTaskId, db = prisma) {
  return db.exportHistory.findFirst({
    where: { shop, scheduledTask: scheduledTaskId },
    select: { id: true },
  });
}

export async function createScheduledExportHistory(data, db = prisma) {
  return db.exportHistory.create({ data });
}
