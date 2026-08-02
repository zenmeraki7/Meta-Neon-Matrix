import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const scheduledExportRunRepository = {
  async create(data, db = prisma) {
    return getClient(db).scheduledExportRun.create({ data });
  },

  async findById(id, db = prisma) {
    return getClient(db).scheduledExportRun.findUnique({
      where: { id },
    });
  },

  async findByExecutionKey(executionDedupeKey, shop, db = prisma) {
    return getClient(db).scheduledExportRun.findUnique({
      where: { shop_executionDedupeKey: { shop, executionDedupeKey } },
    });
  },

  async findByIdWithScheduledExport(id, shop, db = prisma) {
    if (!shop) throw new Error("SHOP_REQUIRED_FOR_SCHEDULED_EXPORT_RUN_LOOKUP");
    return getClient(db).scheduledExportRun.findFirst({
      where: { id, shop },
      include: {
        scheduledExport: true,
        definitionSnapshot: true,
      },
    });
  },

  async updateById(id, data, db = prisma) {
    return getClient(db).scheduledExportRun.update({
      where: { id },
      data,
    });
  },

  async updateByIdForStatuses(id, statuses = [], data = {}, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
      where: {
        id,
        ...(statuses.length ? { status: { in: statuses } } : {}),
      },
      data,
    });
  },

  async updateProcessingState(id, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
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

  async markPendingSkipped(id, data = {}, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
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

  async markProcessingFinished(id, status, data = {}, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
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

  async groupStatusCounts(scheduledExportIds = [], shop, db = prisma) {
    if (!scheduledExportIds.length) {
      return [];
    }

    return getClient(db).scheduledExportRun.groupBy({
      by: ["scheduledExportId", "status"],
      where: {
        shop,
        scheduledExportId: {
          in: scheduledExportIds,
        },
      },
      _count: {
        _all: true,
      },
    });
  },

  async findLatestRuns(scheduledExportIds = [], shop, db = prisma) {
    if (!scheduledExportIds.length) {
      return [];
    }

    return getClient(db).scheduledExportRun.findMany({
      where: {
        shop,
        scheduledExportId: {
          in: scheduledExportIds,
        },
      },
      orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }],
    });
  },

  async reserveRetry(id, { reason, nextAttemptAt }, db = prisma) {
    const updated = await getClient(db).scheduledExportRun.update({
      where: { id },
      data: {
        status: "RETRY_WAIT",
        lastDeferralReason: reason,
        nextAttemptAt,
        retryGeneration: { increment: 1 },
        executionOwnerId: null,
      },
      select: { id: true, retryGeneration: true },
    });
    return updated;
  },

  async claimRun({ runId, ownerId, leaseUntil }, db = prisma) {
    const now = new Date();
    const updated = await getClient(db).scheduledExportRun.updateMany({
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

    const run = await getClient(db).scheduledExportRun.findUnique({
      where: { id: runId },
      select: { executionFence: true },
    });

    return { acquired: true, fence: run?.executionFence ?? 1n };
  },

  async assertRunLease({ runId, ownerId, fence }, db = prisma) {
    const run = await getClient(db).scheduledExportRun.findUnique({
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
