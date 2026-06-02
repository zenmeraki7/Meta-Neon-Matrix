import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const recurringEditRepository = {
  async create(data, db = prisma) {
    return getClient(db).recurringEdit.create({ data });
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

  async updateByIdForShop({ id, shop, data }, db = prisma) {
    const result = await getClient(db).recurringEdit.updateMany({
      where: { id, shop },
      data,
    });
    return result;
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

  async findDueRecurringEditIds(now, limit = 100, db = prisma) {
    return getClient(db).recurringEdit.findMany({
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
      orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });
  },
};
