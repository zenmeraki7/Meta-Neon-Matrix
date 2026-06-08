import {
  buildError,
  deepFreeze,
  normalizeIntInRange,
  toTrimmedString,
  validateNoUnsafeNestedObjects,
} from "./normalizerPrimitives.js";

export function normalizeProductsBootstrapQuery(req = {}, session = null) {
  const shop = toTrimmedString(session?.shop);
  if (!shop) {
    throw buildError("Unauthenticated session", 401, "UNAUTHENTICATED");
  }

  const query = req?.query || {};
  validateNoUnsafeNestedObjects(query, "query", {
    allowedObjectPaths: new Set(),
  });

  const limit = normalizeIntInRange(query.limit, {
    fallback: 50,
    min: 1,
    max: 100,
    fieldName: "limit",
  });

  return deepFreeze({ shop, limit });
}

export function normalizeDashboardBootstrapQuery(session = null) {
  const shop = toTrimmedString(session?.shop);
  if (!shop) {
    throw buildError("Unauthenticated session", 401, "UNAUTHENTICATED");
  }

  return deepFreeze({ shop });
}
