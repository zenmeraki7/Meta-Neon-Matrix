import { prisma } from "../config/database.js";

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

export async function findExportJobForRunFinalize(exportJobId, shop, db = prisma) {
  if (!shop || !exportJobId) {
    throw new Error("SCHEDULED_EXPORT_FINALIZE_REQUIRES_SHOP_AND_EXPORT_JOB_ID");
  }
  return db.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: {
      scheduledExportId: true,
      scheduledExportRunId: true,
      fileUrl: true,
      totalItems: true,
      durationMs: true,
      completedAt: true,
      status: true,
      error: true,
      shop: true,
      filename: true,
    },
  });
}

export async function createScheduledExportJob(data, db = prisma) {
  return db.exportJob.create({ data });
}

export async function findExportJobById(id, shop, db = prisma) {
  if (!shop || !id) {
    throw new Error("EXPORT_JOB_LOOKUP_REQUIRES_SHOP_AND_ID");
  }
  return db.exportJob.findFirst({ where: { id, shop } });
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
      executionState: expectedExecutionState,
    },
    data: {
      targetSnapshotCount: frozenCount,
      executionState: "TARGET_FROZEN",
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
      executionState: expectedExecutionState,
    },
    data,
  });
}

export async function findExportHistoryByScheduledTask(scheduledTaskId, db = prisma) {
  throw new Error("findExportHistoryByScheduledTask requires shop; use findExportHistoryByScheduledTaskForShop");
}

export async function findExportHistoryByScheduledTaskForShop(scheduledTaskId, shop, db = prisma) {
  if (!shop || !scheduledTaskId) {
    throw new Error("EXPORT_HISTORY_LOOKUP_REQUIRES_SHOP_AND_SCHEDULED_TASK");
  }
  return db.exportHistory.findFirst({
    where: { scheduledTask: scheduledTaskId, shop },
    select: { id: true },
  });
}

export async function createScheduledExportHistory(data, db = prisma) {
  return db.exportHistory.create({ data });
}
