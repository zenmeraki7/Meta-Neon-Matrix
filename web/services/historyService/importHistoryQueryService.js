import { db } from "../../repositories/repositoryDb.js";

function normalizeLimit(limit) {
  return Math.min(100, Math.max(1, parseInt(limit || "10", 10)));
}

export async function listImportHistories({ shop, cursor = null, limit = 10 }) {
  const normalizedLimit = normalizeLimit(limit);

  let cursorFilter = {};
  if (cursor) {
    const cursorRow = await db.spreadsheetFile.findFirst({
      where: { id: cursor, shop },
      select: { id: true, createdAt: true },
    });

    if (cursorRow) {
      cursorFilter = {
        OR: [
          { createdAt: { lt: cursorRow.createdAt } },
          { AND: [{ createdAt: cursorRow.createdAt }, { id: { lt: cursorRow.id } }] },
        ],
      };
    }
  }

  const [rows, totalCount] = await Promise.all([
    db.spreadsheetFile.findMany({
      where: {
        AND: [
          { shop },
          ...(Object.keys(cursorFilter).length ? [cursorFilter] : []),
        ],
      },
      orderBy: { createdAt: "desc" },
      take: normalizedLimit + 1,
    }),
    db.spreadsheetFile.count({
      where: { shop },
    }),
  ]);

  const hasNextPage = rows.length > normalizedLimit;
  const histories = hasNextPage ? rows.slice(0, normalizedLimit) : rows;
  const endCursor = histories.length ? histories[histories.length - 1].id : null;

  return {
    histories,
    totalCount,
    pageInfo: {
      hasNextPage,
      endCursor,
    },
  };
}

export async function getImportHistoryDetail({ shop, id }) {
  return db.spreadsheetFile.findFirst({
    where: {
      id,
      shop,
    },
  });
}


