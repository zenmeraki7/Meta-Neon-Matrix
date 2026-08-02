import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const recurringEditRunRepository = {
  async create(data, db = prisma) {
    return getClient(db).recurringEditRun.create({ data });
  },

  async updateById(id, data, db = prisma) {
    return getClient(db).recurringEditRun.update({
      where: { id },
      data,
    });
  },

  async updateByIdForStatuses(id, statuses = [], data = {}, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
      where: {
        id,
        ...(statuses.length ? { status: { in: statuses } } : {}),
      },
      data,
    });
  },

  async updatePendingToProcessing(id, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
      where: {
        id,
        status: "PENDING",
      },
      data: {
        status: "PROCESSING",
        startedAt: new Date(),
      },
    });
  },

  async markProcessingFinished(id, status, data = {}, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
      where: {
        id,
        status: "PROCESSING",
      },
      data: {
        status,
        completedAt: new Date(),
        ...data,
      },
    });
  },

  async markPendingSkipped(id, data = {}, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
      where: {
        id,
        status: "PENDING",
      },
      data: {
        status: "SKIPPED",
        completedAt: new Date(),
        ...data,
      },
    });
  },

  async findById(id, db = prisma) {
    return getClient(db).recurringEditRun.findUnique({
      where: { id },
    });
  },

  async findByExecutionKey(executionDedupeKey, shop, db = prisma) {
    return getClient(db).recurringEditRun.findUnique({
      where: { shop_executionDedupeKey: { shop, executionDedupeKey } },
    });
  },

  async findByIdWithRecurringEdit(id, shop, db = prisma) {
    if (!shop) throw new Error("SHOP_REQUIRED_FOR_RECURRING_RUN_LOOKUP");
    return getClient(db).recurringEditRun.findFirst({
      where: { id, shop },
      include: {
        recurringEdit: true,
        definitionSnapshot: true,
      },
    });
  },

  async findByEditHistoryId(editHistoryId, db = prisma) {
    return getClient(db).recurringEditRun.findFirst({
      where: { editHistoryId },
      include: {
        recurringEdit: true,
      },
    });
  },

  async groupStatusCounts(recurringEditIds = [], shop, db = prisma) {
    if (!recurringEditIds.length) {
      return [];
    }

    return getClient(db).recurringEditRun.groupBy({
      by: ["recurringEditId", "status"],
      where: {
        shop,
        recurringEditId: {
          in: recurringEditIds,
        },
      },
      _count: {
        _all: true,
      },
    });
  },

  async findLatestRuns(recurringEditIds = [], shop, db = prisma) {
    if (!recurringEditIds.length) {
      return [];
    }

    return getClient(db).recurringEditRun.findMany({
      where: {
        shop,
        recurringEditId: {
          in: recurringEditIds,
        },
      },
      orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }],
    });
  },

  async markRetryWait(id, { reason, nextAttemptAt, retryCount }, db = prisma) {
    return getClient(db).recurringEditRun.update({
      where: { id },
      data: {
        status: "RETRY_WAIT",
        errorMessage: reason,
        nextAttemptAt,
        retryCount: retryCount !== undefined ? retryCount : undefined,
        executionOwnerId: null,
      },
    });
  },

  async claimRun({ runId, ownerId, leaseUntil }, db = prisma) {
    const now = new Date();
    const updated = await getClient(db).recurringEditRun.updateMany({
      where: {
        id: runId,
        OR: [
          { executionOwnerId: null },
          { executionLeaseUntil: { lt: now } },
          { executionOwnerId: ownerId },
        ],
      },
      data: {
        executionOwnerId: ownerId,
        executionLeaseUntil: leaseUntil,
        executionFence: { increment: 1 },
      },
    });

    if (updated.count !== 1) {
      return { acquired: false, fence: null };
    }

    const run = await getClient(db).recurringEditRun.findUnique({
      where: { id: runId },
      select: { executionFence: true },
    });

    return { acquired: true, fence: run?.executionFence ?? 1n };
  },

  async assertRunLease({ runId, ownerId, fence }, db = prisma) {
    const run = await getClient(db).recurringEditRun.findUnique({
      where: { id: runId },
      select: { executionOwnerId: true, executionLeaseUntil: true, executionFence: true },
    });

    const now = new Date();
    if (
      !run ||
      run.executionOwnerId !== ownerId ||
      (fence !== undefined && BigInt(run.executionFence) !== BigInt(fence)) ||
      (run.executionLeaseUntil && run.executionLeaseUntil < now)
    ) {
      const error = new Error("RUN_LEASE_EXPIRED_OR_LOST");
      error.code = "RUN_LEASE_EXPIRED_OR_LOST";
      throw error;
    }
  },
};
