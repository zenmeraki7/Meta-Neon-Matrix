import { getForGrid, hasStaleVariantSync } from "../db/variantMetafields.js";
import { requireShopScope } from "../utils/shopScope.js";

const VARIANT_GRID_QUERY_KEYS = new Set(["productIds", "cursor", "limit"]);
const STALE_CACHE_TTL_MS = 60_000;
const staleCache = new Map();

function normalizeVariantGridQuery(query = {}) {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    throw new Error("VARIANT_GRID_QUERY_INVALID");
  }
  const unknownKeys = Object.keys(query).filter((key) => !VARIANT_GRID_QUERY_KEYS.has(key));
  if (unknownKeys.length) {
    const error = new Error(`VARIANT_GRID_QUERY_UNSUPPORTED_KEYS:${unknownKeys.join(",")}`);
    error.code = "VALIDATION_FAILED";
    throw error;
  }

  const rawProductIds = Array.isArray(query.productIds)
    ? query.productIds
    : query.productIds == null
      ? []
      : String(query.productIds)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
  if (rawProductIds.length > 500) {
    const error = new Error("VARIANT_GRID_PRODUCT_IDS_LIMIT_EXCEEDED");
    error.code = "VALIDATION_FAILED";
    throw error;
  }
  const productIds = rawProductIds.map((id) => {
    const value = String(id ?? "").trim();
    if (!/^\d+$/.test(value)) {
      const error = new Error("VARIANT_GRID_PRODUCT_ID_INVALID");
      error.code = "VALIDATION_FAILED";
      throw error;
    }
    return value;
  });

  const cursor = query.cursor == null || query.cursor === ""
    ? null
    : String(query.cursor).trim();
  if (cursor && !/^\d+$/.test(cursor)) {
    const error = new Error("VARIANT_GRID_CURSOR_INVALID");
    error.code = "VALIDATION_FAILED";
    throw error;
  }

  const rawLimit = Number.parseInt(String(query.limit ?? 50), 10);
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));

  return { productIds, cursor, limit };
}

async function getCachedStaleFlag(shop) {
  const now = Date.now();
  const cached = staleCache.get(shop);
  if (cached && cached.expiresAt > now) return cached.value;
  const value = await hasStaleVariantSync(shop, 30);
  staleCache.set(shop, {
    value,
    expiresAt: now + STALE_CACHE_TTL_MS,
  });
  return value;
}

export async function fetchVariantGridRows(shop, query = {}) {
  const scopedShop = requireShopScope(shop);
  const normalizedQuery = normalizeVariantGridQuery(query);
  const [variants, isStale] = await Promise.all([
    getForGrid(scopedShop, normalizedQuery),
    getCachedStaleFlag(scopedShop),
  ]);

  return { variants, isStale };
}
