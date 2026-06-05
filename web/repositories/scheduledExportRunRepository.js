import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const scheduledExportRunRepository = {
  async create(data, db = prisma) {
    return getClient(db).scheduledExportRun.create({ data });
  },

  async findById(id, shop, db = prisma) {
    return getClient(db).scheduledExportRun.findFirst({
      where: { id, shop },
    });
  },

  async findByExecutionKey(executionKey, shop, db = prisma) {
    return getClient(db).scheduledExportRun.findFirst({
      where: { executionKey, shop },
    });
  },

  async findByIdWithScheduledExport(id, shop, db = prisma) {
    return getClient(db).scheduledExportRun.findFirst({
      where: { id, shop },
      include: {
        scheduledExport: true,
      },
    });
  },

  async updateById(id, shop, data, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
      where: { id, shop },
      data,
    });
  },

  async updateByIdForStatuses(id, shop, statuses = [], data = {}, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
      where: {
        id,
        shop,
        ...(statuses.length ? { status: { in: statuses } } : {}),
      },
      data,
    });
  },

  async updateProcessingState(id, shop, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
      where: {
        id,
        shop,
        status: "PENDING",
      },
      data: {
        status: "PROCESSING",
        startedAt: new Date(),
      },
    });
  },

  async markPendingSkipped(id, shop, data = {}, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
      where: {
        id,
        shop,
        status: "PENDING",
      },
      data: {
        status: "SKIPPED",
        completedAt: new Date(),
        ...data,
      },
    });
  },

  async markProcessingFinished(id, shop, status, data = {}, db = prisma) {
    return getClient(db).scheduledExportRun.updateMany({
      where: {
        id,
        shop,
        status: "PROCESSING",
      },
      data: {
        status,
        completedAt: new Date(),
        ...data,
      },
    });
  },

  async groupStatusCounts(shop, scheduledExportIds = [], db = prisma) {
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

  async findLatestRuns(shop, scheduledExportIds = [], db = prisma) {
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
};
