import { getForGrid, hasStaleVariantSync } from "../db/variantMetafields.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function fetchVariantGridRows(shop, query) {
  const scopedShop = requireShopScope(shop);
  const [variants, isStale] = await Promise.all([
    getForGrid(scopedShop, query),
    hasStaleVariantSync(scopedShop, 30),
  ]);

  return { variants, isStale };
}
