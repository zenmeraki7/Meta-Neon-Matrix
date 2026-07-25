export function normalizeVariantGridQuery(query = {}) {
  const { productIds, cursor, limit = 50 } = query || {};
  return Object.freeze({ productIds, cursor, limit });
}
