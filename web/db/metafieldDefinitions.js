import { prisma } from "../config/database.js";

/**
 * Returns metafield definitions scoped to shop.
 * @param {string} shop
 * @returns {Promise<Array<object>>}
 */
export async function getDefinitions(shop) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) throw new Error("getDefinitions requires shop");
  return prisma.$queryRaw`
    SELECT
      id,
      shopify_definition_id,
      namespace,
      key,
      name,
      description,
      type,
      validations,
      visible_to_storefront
    FROM metafield_definitions
    WHERE shop_id = ${resolvedShop}
    ORDER BY namespace ASC, key ASC
  `;
}

/**
 * Returns one metafield definition by namespace+key scoped to shop.
 * @param {string} shop
 * @param {string} namespace
 * @param {string} key
 * @returns {Promise<object|null>}
 */
export async function getDefinition(shop, namespace, key) {
  const resolvedShop = String(shop || "").trim();
  const resolvedNamespace = String(namespace || "").trim();
  const resolvedKey = String(key || "").trim();
  if (!resolvedShop || !resolvedNamespace || !resolvedKey) return null;
  const rows = await prisma.$queryRaw`
    SELECT
      id,
      shopify_definition_id,
      namespace,
      key,
      name,
      description,
      type,
      validations,
      visible_to_storefront
    FROM metafield_definitions
    WHERE shop_id = ${resolvedShop}
      AND namespace = ${resolvedNamespace}
      AND key = ${resolvedKey}
    LIMIT 1
  `;
  return rows[0] || null;
}

