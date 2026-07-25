import { columnApplyFanout, stageChanges } from "../db/bulkEditChanges.js";
import { getScoped } from "../db/bulkEditSessions.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function findSessionScoped(sessionId, shopDomain) {
  const scopedShopDomain = requireShopScope(shopDomain, "shopDomain");
  return getScoped(sessionId, scopedShopDomain);
}

export async function writeStagedSessionChanges(sessionId, shopDomain, changes) {
  const scopedShopDomain = requireShopScope(shopDomain, "shopDomain");
  return stageChanges(sessionId, scopedShopDomain, changes);
}

export async function writeColumnAppliedSessionChanges(
  sessionId,
  shopDomain,
  namespace,
  key,
  value,
  variantIds,
) {
  const scopedShopDomain = requireShopScope(shopDomain, "shopDomain");
  return columnApplyFanout(sessionId, scopedShopDomain, namespace, key, value, variantIds);
}
