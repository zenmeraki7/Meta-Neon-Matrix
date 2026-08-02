import { prisma } from "../config/database.js";
import { persistScheduledExportRevision } from "../services/scheduleRevisionService.js";

function getClient(db) {
  return db || prisma;
}

export const scheduledExportRepository = {
  async create(data, db = prisma) {
    const create = async (tx) => {
      const definition = await tx.scheduledExport.create({ data });
      await persistScheduledExportRevision({ tx, definition });
      return definition;
    };
    return db === prisma ? prisma.$transaction(create) : create(getClient(db));
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
    const update = async (tx) => {
      const result = await tx.scheduledExport.updateMany({
        where: { id, shop, ...(expectedRevision == null ? {} : { revision: expectedRevision }) },
        data: expectedRevision == null ? data : { ...data, revision: { increment: 1 } },
      });
      if (result.count === 1 && expectedRevision != null) {
        const definition = await tx.scheduledExport.findFirst({ where: { id, shop, revision: expectedRevision + 1 } });
        if (!definition) throw new Error("SCHEDULED_EXPORT_REVISION_RELOAD_FAILED");
        await persistScheduledExportRevision({ tx, definition });
      }
      return result;
    };
    return db === prisma && expectedRevision != null
      ? prisma.$transaction(update)
      : update(getClient(db));
  },

  async findDueScheduledExportIds() {
    throw new Error("DIRECT_DEFINITION_SCHEDULER_CLAIM_FORBIDDEN");
  },
};
