import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const scheduledExportRepository = {
  async create(data, db = prisma) {
    return getClient(db).scheduledExport.create({ data });
  },

  async findById(id, db = prisma) {
    return getClient(db).scheduledExport.findUnique({
      where: { id },
    });
  },

  async findByIdForShop(id, shop, db = prisma) {
    return getClient(db).scheduledExport.findFirst({
      where: {
        id,
        shop,
        isDeleted: false,
      },
    });
  },

  async listByShop(shop, db = prisma) {
    return getClient(db).scheduledExport.findMany({
      where: {
        shop,
        isDeleted: false,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  },

  async updateByIdForShop({ id, shop, data, expectedRevision = null }, db = prisma) {
    const result = await getClient(db).scheduledExport.updateMany({
      where: { id, shop, ...(expectedRevision == null ? {} : { revision: expectedRevision }) },
      data: expectedRevision == null ? data : { ...data, revision: { increment: 1 } },
    });
    return result;
  },

  async findDueScheduledExportIds(now, limit = 100, db = prisma) {
    return getClient(db).scheduledExport.findMany({
      where: {
        isDeleted: false,
        status: "ACTIVE",
        nextRunAt: {
          lte: now,
        },
      },
      select: {
        id: true,
      },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: limit,
    });
  },
};
