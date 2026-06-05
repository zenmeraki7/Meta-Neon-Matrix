import { toStoreAccessDto } from "./storeAccessDto.js";

function asIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toBootstrapSummaryDto(payload = {}) {
  const syncStatus = payload.syncSummaryResponse?.syncStatus || payload.syncStatus || null;

  return {
    ok: payload.ok !== false,
    shop: payload.shop ? String(payload.shop) : null,
    generatedAt: asIso(payload.generatedAt) || new Date().toISOString(),
    storeDetails: payload.storeDetails
      ? toStoreAccessDto(payload.storeDetails)
      : null,
    syncStatus: syncStatus && typeof syncStatus === "object"
      ? syncStatus
      : null,
    operationSummary: payload.operationSummary && typeof payload.operationSummary === "object"
      ? payload.operationSummary
      : { activeCount: 0, latestActiveOperation: null },
    filterRegistry: payload.filterRegistry && typeof payload.filterRegistry === "object"
      ? payload.filterRegistry
      : undefined,
    productList: payload.productList && typeof payload.productList === "object"
      ? payload.productList
      : undefined,
    planSnapshot: payload.planSnapshot && typeof payload.planSnapshot === "object"
      ? payload.planSnapshot
      : payload.planSnapshot === undefined
        ? undefined
        : { currentPlanKey: "FREE", plans: [] },
  };
}
