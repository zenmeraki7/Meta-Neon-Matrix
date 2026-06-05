import { prisma } from "../config/database.js";

function getClient(db) {
  return db || prisma;
}

export const productCodeSnippetRepository = {
  async create(data, db = prisma) {
    return getClient(db).productCodeSnippet.create({ data });
  },

  async findById(id, db = prisma) {
    throw new Error("productCodeSnippetRepository.findById requires shop; use findByIdForShop");
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

  async updateByIdForShop({ id, shop, data }, db = prisma) {
    const updated = await getClient(db).productCodeSnippet.updateMany({
      where: { id, shop, isDeleted: false },
      data,
    });
    if (!updated?.count) return null;
    return getClient(db).productCodeSnippet.findFirst({
      where: { id, shop, isDeleted: false },
    });
  },
};
