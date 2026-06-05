export const CACHE_KEY_REGISTRY = Object.freeze({
  productSync: Object.freeze({
    detail: (shop) => `${shop}:sync_details`,
    summary: (shop) => `${shop}:sync_summary`,
    summaryV2: (shop) => `${shop}:sync_summary:v2`,
  }),
});

export function getProductSyncCacheKeys(shop) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("getProductSyncCacheKeys requires shop");
  }

  return Object.values(CACHE_KEY_REGISTRY.productSync).map((buildKey) =>
    buildKey(scopedShop),
  );
}
