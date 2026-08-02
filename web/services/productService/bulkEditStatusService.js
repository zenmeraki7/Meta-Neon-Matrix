import { db } from "../../repositories/repositoryDb.js";
import { normalizeShopDomain } from "../../utils/shopDomainUtils.js";

function buildNotFoundError() {
  const error = new Error("Requested edit history record was not found");
  error.code = "NOT_FOUND";
  return error;
}

export async function getBulkEditStatus(command = {}) {
  const shop = normalizeShopDomain(command.shop);
  const historyId = command.historyId || command.id;

  if (!shop || !historyId) {
    throw buildNotFoundError();
  }

  const history = await db.editHistory.findFirst({
    where: {
      shop,
      id: String(historyId),
    },
    select: {
      id: true,
      shop: true,
      statusNormalized: true,
      processedCount: true,
      totalItems: true,
      durationMs: true,
    },
  });

  if (!history) {
    throw buildNotFoundError();
  }

  return {
    id: history.id,
    shop: history.shop,
    status: String(history.statusNormalized || "UNKNOWN").toLowerCase(),
    rootObjectCount: history.processedCount || 0,
    totalItems: history.totalItems || 0,
    duration: history.durationMs || 0,
  };
}
