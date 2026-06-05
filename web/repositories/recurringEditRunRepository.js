import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const recurringEditRunRepository = {
  async create(data, db = prisma) {
    return getClient(db).recurringEditRun.create({ data });
  },

  async updateById(id, shop, data, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
      where: { id, shop },
      data,
    });
  },

  async updateByIdForStatuses(id, shop, statuses = [], data = {}, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
      where: {
        id,
        shop,
        ...(statuses.length ? { status: { in: statuses } } : {}),
      },
      data,
    });
  },

  async updatePendingToProcessing(id, shop, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
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

  async markProcessingFinished(id, shop, status, data = {}, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
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

  async markPendingSkipped(id, shop, data = {}, db = prisma) {
    return getClient(db).recurringEditRun.updateMany({
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

  async findById(id, shop, db = prisma) {
    return getClient(db).recurringEditRun.findFirst({
      where: { id, shop },
    });
  },

  async findByExecutionKey(executionKey, shop, db = prisma) {
    return getClient(db).recurringEditRun.findFirst({
      where: { executionKey, shop },
    });
  },

  async findByIdWithRecurringEdit(id, shop, db = prisma) {
    return getClient(db).recurringEditRun.findFirst({
      where: { id, shop },
      include: {
        recurringEdit: true,
      },
    });
  },

  async findByEditHistoryId(editHistoryId, shop, db = prisma) {
    return getClient(db).recurringEditRun.findFirst({
      where: { editHistoryId, shop },
      include: {
        recurringEdit: true,
      },
    });
  },

  async groupStatusCounts(recurringEditIds = [], shop, db = prisma) {
    if (!recurringEditIds.length) {
      return [];
    }
    if (!shop) {
      throw new Error("recurringEditRunRepository.groupStatusCounts requires shop");
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
    if (!shop) {
      throw new Error("recurringEditRunRepository.findLatestRuns requires shop");
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
};
