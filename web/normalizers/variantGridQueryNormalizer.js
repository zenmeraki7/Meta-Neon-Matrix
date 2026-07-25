import {
  buildError,
  deepFreeze,
  normalizeIntInRange,
  validateNoUnsafeNestedObjects,
  validateVariantCursor,
  capLength,
} from "./normalizerPrimitives.js";

function normalizeProductIds(raw) {
  if (!Array.isArray(raw)) {
    throw buildError("Invalid variants query request.", 400, "VALIDATION_FAILED", [
      { field: "productIds", error: "must be an array" },
    ]);
  }

  const input = raw
    .map((id) => String(id || "").trim())
    .filter(Boolean);

  if (input.length > 50) {
    throw buildError("Invalid variants query request.", 400, "VALIDATION_FAILED", [
      { field: "productIds", error: "max 50 ids" },
    ]);
  }

  return input.map((id) => {
    const value = capLength(String(id || "").trim(), 200, "productIds");
    const gidMatch = value.match(/^gid:\/\/shopify\/Product\/(\d+)$/);

    if (!gidMatch) {
      throw buildError("Invalid variants query request.", 400, "VALIDATION_FAILED", [
        { field: "productIds", error: "must be Shopify Product GIDs" },
      ]);
    }

    return Object.freeze({
      gid: value,
      numericId: gidMatch[1],
    });
  });
}

export function normalizeVariantGridQuery(params = {}, query = {}, locals = {}) {
  void params;
  const shop = String(locals.shop || "").trim();
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
    max: 500,
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
