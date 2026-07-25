import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const productCodeSnippetRepository = {
  async create(data, db = prisma) {
    return getClient(db).productCodeSnippet.create({ data });
  },

  async findById(id, db = prisma) {
    return getClient(db).productCodeSnippet.findUnique({
      where: { id },
    });
  },

  async findByIdForShop(id, shop, db = prisma) {
    return getClient(db).productCodeSnippet.findFirst({
      where: {
        id,
        shop,
        isDeleted: false,
      },
    });
  },

  async listByShop({ shop, search = "", status = null }, db = prisma) {
    return getClient(db).productCodeSnippet.findMany({
      where: {
        shop,
        isDeleted: false,
        ...(status ? { status } : {}),
        ...(search
          ? {
              title: {
                contains: search,
                mode: "insensitive",
              },
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  },

  async updateByIdForShop({ id, shop, data, expectedRevision = null }, db = prisma) {
    const updated = await getClient(db).productCodeSnippet.updateMany({
      where: {
        id,
        shop,
        isDeleted: false,
        ...(expectedRevision == null ? {} : { revision: expectedRevision }),
      },
      data: expectedRevision == null ? data : { ...data, revision: { increment: 1 } },
    });
    if (!updated?.count) return null;
    return getClient(db).productCodeSnippet.findFirst({
      where: { id, shop, isDeleted: false },
    });
  },
};
