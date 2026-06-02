import { prisma } from "../config/database.js";

/**
 * Returns active variants for product ids scoped to shop.
 * @param {string} shop
 * @param {Array<bigint>} productIds
 * @returns {Promise<Array<object>>}
 */
export async function getVariantsByProductIds(shop, productIds) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("getVariantsByProductIds requires shop");
  if (!Array.isArray(productIds) || productIds.length === 0) return [];
  const ids = productIds.map((id) => BigInt(id).toString());
  return prisma.$queryRaw`
    SELECT
      id,
      product_id,
      title,
      sku,
      price,
      inventory_quantity,
      position,
      option_values
    FROM variants
    WHERE shop_id = ${resolvedShop}
      AND is_deleted = false
      AND product_id = ANY(${ids}::bigint[])
    ORDER BY product_id ASC, position ASC, id ASC
  `;
}

