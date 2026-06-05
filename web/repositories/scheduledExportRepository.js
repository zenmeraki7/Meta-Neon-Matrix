import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const scheduledExportRepository = {
  async create(data, db = prisma) {
    return getClient(db).scheduledExport.create({ data });
  },

  async findById(id, db = prisma) {
    throw new Error("scheduledExportRepository.findById requires shop; use findByIdForShop");
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

  async updateByIdForShop({ id, shop, data }, db = prisma) {
    const result = await getClient(db).scheduledExport.updateMany({
      where: { id, shop },
      data,
    });
    return result;
  },

  async findDueScheduledExportIds(now, limit = 100, db = prisma) {
    throw new Error("findDueScheduledExportIds requires shop; use findDueScheduledExportIdsForShop");
  },

  async findDueScheduledExportIdsForShop(shop, now, limit = 100, db = prisma) {
    if (!shop) {
      throw new Error("findDueScheduledExportIdsForShop requires shop");
    }
    return getClient(db).scheduledExport.findMany({
      where: {
        shop,
        isDeleted: false,
        status: "ACTIVE",
        nextRunAt: {
          lte: now,
        },
      },
      select: {
        id: true,
      },
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });
  },
};
