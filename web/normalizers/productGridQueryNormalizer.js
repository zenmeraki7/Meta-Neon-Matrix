import {
  buildError,
  deepFreeze,
  normalizeEnum,
  normalizeIntInRange,
  normalizeOptionalString,
  validateNoUnsafeNestedObjects,
  validateProductCursor,
} from "./normalizerPrimitives.js";

export function normalizeProductGridQuery(params = {}, query = {}, locals = {}) {
  void params;
  const shopId = String(locals.shopify?.session?.shop || "").trim();
  if (!shopId) {
    throw buildError("Unauthenticated session", 401, "UNAUTHENTICATED");
  }

  validateNoUnsafeNestedObjects(query, "query", {
    allowedObjectPaths: new Set(),
  });

  const limit = normalizeIntInRange(query.limit, {
    fallback: 50,
    min: 1,
    max: 200,
    fieldName: "limit",
  });

  const cursor = validateProductCursor(query.cursor);
  const status = normalizeEnum(query.status, ["ACTIVE", "ARCHIVED", "DRAFT"], "status");

  return deepFreeze({
    shop: shopId,
    filters: {
      limit,
      cursor,
      search: normalizeOptionalString(query.search, 120, "search"),
      status,
      vendor: normalizeOptionalString(query.vendor, 120, "vendor"),
      productType: normalizeOptionalString(query.productType, 120, "productType"),
      tag: normalizeOptionalString(query.tag, 80, "tag"),
    },
  });
}
