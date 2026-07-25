import { listProducts as listProductsMirror } from "../../db/products.js";
import { getDefinitions } from "../db/metafieldDefinitions.js";
import { getVariantsByProductIds } from "../db/productGrid.js";
import { getMetafieldsForVariants } from "../db/variantMetafields.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function fetchProductGridRows(shopDomain, filters) {
  const scopedShop = requireShopScope(shopDomain, "shopDomain");
  const listed = await listProductsMirror(scopedShop, {
    limit: filters.limit,
    cursor: filters.cursor,
    search: filters.search,
    status: filters.status,
    vendor: filters.vendor,
  });

  const filteredProducts = filters.productType
    ? listed.products.filter((p) => String(p.productType || "") === filters.productType)
    : listed.products;
  const tagFilteredProducts = filters.tag
    ? filteredProducts.filter((p) => Array.isArray(p.tags) && p.tags.includes(filters.tag))
    : filteredProducts;

  const productIds = tagFilteredProducts.map((p) => BigInt(p.id));
  const variants = await getVariantsByProductIds(scopedShop, productIds);
  const variantIds = variants.map((v) => BigInt(v.id));
  const [definitions, metafields] = await Promise.all([
    getDefinitions(scopedShop),
    getMetafieldsForVariants(scopedShop, variantIds),
  ]);

  return {
    listed,
    products: tagFilteredProducts,
    variants,
    definitions,
    metafields,
  };
}
