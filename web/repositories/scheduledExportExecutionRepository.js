import { prisma } from "../config/database.js";

function assertPlainObject(value, errorCode) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorCode);
  }
  return value;
}

function normalizeCreateData(input, errorCode) {
  const candidate = input?.data && typeof input.data === "object"
    ? input.data
    : input;
  const data = assertPlainObject(candidate, errorCode);
  if (!data.shop) {
    throw new Error(errorCode);
  }
  return data;
}

export async function withScheduledExportExecutionTransaction(fn, options = {}) {
  return prisma.$transaction(async (tx) => fn(tx), options);
}

export async function tryAdvisoryLockTx(tx, lockKey) {
  const rows = await tx.$queryRaw`
    SELECT pg_try_advisory_xact_lock(
      ('x' || substr(md5(${lockKey}), 1, 16))::bit(64)::bigint
    ) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function tryAdvisoryLockSession(lockKey) {
  const rows = await prisma.$queryRaw`
    SELECT pg_try_advisory_lock(
      ('x' || substr(md5(${lockKey}), 1, 16))::bit(64)::bigint
    ) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function unlockAdvisoryLockSession(lockKey) {
  await prisma.$queryRaw`
    SELECT pg_advisory_unlock(
      ('x' || substr(md5(${lockKey}), 1, 16))::bit(64)::bigint
    )
  `;
}

export async function withAdvisoryLockSession(lockKey, fn) {
  const locked = await tryAdvisoryLockSession(lockKey);
  if (!locked) {
    return { locked: false, result: null };
  }

  try {
    const result = await fn();
    return { locked: true, result };
  } finally {
    await unlockAdvisoryLockSession(lockKey).catch(() => {});
  }
}

export async function findExportJobByScheduledRun(shop, scheduledExportRunId, db = prisma) {
  if (!shop || !scheduledExportRunId) {
    throw new Error("EXPORT_JOB_LOOKUP_REQUIRES_SHOP_AND_RUN_ID");
  }
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
  return db.exportJob.create({
    data: normalizeCreateData(data, "EXPORT_JOB_CREATE_REQUIRES_SHOP"),
  });
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
  targetFrozenExecutionState = "TARGET_FROZEN",
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
      executionState: targetFrozenExecutionState,
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
  return db.exportHistory.create({
    data: normalizeCreateData(data, "EXPORT_HISTORY_CREATE_REQUIRES_SHOP"),
  });
}
