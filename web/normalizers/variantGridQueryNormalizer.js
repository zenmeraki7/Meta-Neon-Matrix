import {
  buildError,
  deepFreeze,
  normalizeIntInRange,
  validateNoUnsafeNestedObjects,
  validateVariantCursor,
  capLength,
} from "./normalizerPrimitives.js";

function normalizeProductIds(raw) {
  const input = Array.isArray(raw)
    ? raw
    : raw == null
      ? []
      : String(raw)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

  if (input.length > 500) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "productIds", error: "max 500 ids" },
    ]);
  }

  return input.map((id) => {
    const value = capLength(id, 32, "productIds");
    if (!/^\d+$/.test(value)) {
      throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
        { field: "productIds", error: "must be numeric ids" },
      ]);
    }
    return value;
  });
}

export function normalizeVariantGridQuery(params = {}, query = {}, locals = {}) {
  void params;
  const shop = String(locals.shopify?.session?.shop || "").trim();
  if (!shop) {
    throw buildError("Unauthenticated session", 401, "UNAUTHENTICATED");
  }

  validateNoUnsafeNestedObjects(query, "query", {
    allowedObjectPaths: new Set(),
  });

  const cursor = validateVariantCursor(query.cursor);
  const limit = normalizeIntInRange(query.limit, {
    fallback: 50,
    min: 1,
    max: 200,
    fieldName: "limit",
  });
  const productIds = normalizeProductIds(query.productIds);

  return deepFreeze({
    shop,
    query: {
      productIds,
      cursor,
      limit,
    },
  });
}
