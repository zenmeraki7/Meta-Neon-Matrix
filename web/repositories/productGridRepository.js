import { listProducts as listProductsMirror } from "../../db/products.js";
import { getVariantsByProductIds } from "../db/productGrid.js";
import { getMetafieldsForVariants } from "../db/variantMetafields.js";
import { requireShopScope } from "../utils/shopScope.js";

function normalizeFilters(filters = {}) {
  return {
    limit: filters?.limit,
    cursor: filters?.cursor,
    search: filters?.search,
    status: filters?.status,
    vendor: filters?.vendor,
    productType: filters?.productType,
    tag: filters?.tag,
  };
}

function toSafeNumericIds(rows, field = "id") {
  return rows
    .map((row) => String(row?.[field] ?? "").trim())
    .filter((id) => /^\d+$/.test(id));
}

export async function fetchProductGridRows(shop, filters = {}) {
  const scopedShop = requireShopScope(shop, "shop");
  const normalizedFilters = normalizeFilters(filters);
  const listed = await listProductsMirror(scopedShop, {
    ...normalizedFilters,
  });

  const products = Array.isArray(listed.products) ? listed.products : [];
  const productIds = toSafeNumericIds(products);
  const variants = await getVariantsByProductIds(scopedShop, productIds);
  const variantIds = toSafeNumericIds(variants);
  const metafields = await getMetafieldsForVariants(scopedShop, variantIds);

  return {
    listed,
    products,
    variants,
    metafields,
  };
}
