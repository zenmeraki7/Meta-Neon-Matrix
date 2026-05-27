import { prisma } from "../../config/database.js";

export async function getBulkEditStatus({ shop, id }) {
  const history = await prisma.editHistory.findFirst({
    where: {
      id,
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

