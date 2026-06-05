import { db } from "../../repositories/repositoryDb.js";

export async function getBulkEditStatus({ shop, historyId }) {
  const history = await db.editHistory.findFirst({
    where: {
      id: historyId,
      shop,
    },
    select: {
      processedCount: true,
      totalItems: true,
      durationMs: true,
    },
  });

  if (!history) {
    return {
      status: "not_found",
      message: "No history found",
    };
  }

  return {
    rootObjectCount: history.processedCount,
    totalItems: history.totalItems,
    duration: history.durationMs,
  };
}

