import { prisma } from "../config/database.js";
import { persistRecurringEditRevision } from "../services/scheduleRevisionService.js";

function getClient(db) {
  return db || prisma;
}

export const recurringEditRepository = {
  async create(data, db = prisma) {
    const create = async (tx) => {
      const definition = await tx.recurringEdit.create({ data });
      await persistRecurringEditRevision({ tx, definition });
      return definition;
    };
    return db === prisma ? prisma.$transaction(create) : create(getClient(db));
  },

  async findById(id, db = prisma) {
    return getClient(db).recurringEdit.findUnique({
      where: { id },
    });
  },

  async findByIdForShop(id, shop, db = prisma) {
    return getClient(db).recurringEdit.findFirst({
      where: {
        id,
        shop,
        isDeleted: false,
      },
    });
  },

  async listByShop(
    shop,
    { where = {}, take = undefined, orderBy = [{ createdAt: "desc" }, { id: "desc" }] } = {},
    db = prisma,
  ) {
    return getClient(db).recurringEdit.findMany({
      where: {
        shop,
        isDeleted: false,
        ...where,
      },
      orderBy,
      ...(take ? { take } : {}),
    });
  },

  async updateByIdForShop({ id, shop, data, expectedRevision = null }, db = prisma) {
    const update = async (tx) => {
      const result = await tx.recurringEdit.updateMany({
        where: { id, shop, ...(expectedRevision == null ? {} : { revision: expectedRevision }) },
        data: expectedRevision == null ? data : { ...data, revision: { increment: 1 } },
      });
      if (result.count === 1 && expectedRevision != null) {
        const definition = await tx.recurringEdit.findFirst({ where: { id, shop, revision: expectedRevision + 1 } });
        if (!definition) throw new Error("RECURRING_EDIT_REVISION_RELOAD_FAILED");
        await persistRecurringEditRevision({ tx, definition });
      }
      return result;
    };
    return db === prisma && expectedRevision != null
      ? prisma.$transaction(update)
      : update(getClient(db));
  },

  async countActiveByShop(shop, excludeId = null, db = prisma) {
    return getClient(db).recurringEdit.count({
      where: {
        shop,
        isDeleted: false,
        status: "ACTIVE",
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  },

  async findDueRecurringEditIds() {
    throw new Error("DIRECT_DEFINITION_SCHEDULER_CLAIM_FORBIDDEN");
  },
};
