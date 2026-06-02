import { columnApplyFanout, stageChanges } from "../db/bulkEditChanges.js";
import { getScoped } from "../db/bulkEditSessions.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function findSessionScoped(sessionId, shopId) {
  const scopedShopId = requireShopScope(shopId, "shopId");
  return getScoped(sessionId, scopedShopId);
}

export async function writeStagedSessionChanges(sessionId, shopId, changes) {
  const scopedShopId = requireShopScope(shopId, "shopId");
  return stageChanges(sessionId, scopedShopId, changes);
}

export async function writeColumnAppliedSessionChanges(
  sessionId,
  shopId,
  namespace,
  key,
  value,
  variantIds,
) {
  const scopedShopId = requireShopScope(shopId, "shopId");
  return columnApplyFanout(sessionId, scopedShopId, namespace, key, value, variantIds);
}
