import sql from "./client.js";

/**
 * Upserts a shop row when auth completes.
 * @param {{ shopDomain: string, scope: string }} params
 * @returns {Promise<{
 *   id: string,
 *   shopify_domain: string,
 *   scope: string,
 *   plan: string,
 *   active: boolean,
 *   installed_at: string,
 *   uninstalled_at: string | null,
 *   last_synced_at: string | null
 * }>}
 * @throws {Error}
 */
export async function upsertShop({ shopDomain, scope }) {
  const domain = String(shopDomain || "").trim();
  const resolvedScope = String(scope || "").trim();

  if (!domain) throw new Error("upsertShop requires shopDomain");
  if (!resolvedScope) throw new Error("upsertShop requires scope");

  const rows = await sql`
    INSERT INTO shops (id, shopify_domain, scope, active, uninstalled_at)
    VALUES (${domain}, ${domain}, ${resolvedScope}, true, NULL)
    ON CONFLICT (id)
    DO UPDATE SET
      shopify_domain = EXCLUDED.shopify_domain,
      scope = EXCLUDED.scope,
      active = true,
      uninstalled_at = NULL
    RETURNING *
  `;

  return rows[0] || null;
}

/**
 * Returns one shop row by id.
 * @param {string} shopDomain
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function getShop(shopDomain) {
  const id = String(shopDomain || "").trim();
  if (!id) throw new Error("getShop requires shopDomain");

  const rows = await sql`
    SELECT *
    FROM shops
    WHERE id = ${id}
    LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * Marks a shop as uninstalled.
 * @param {string} shopDomain
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function deactivateShop(shopDomain) {
  const id = String(shopDomain || "").trim();
  if (!id) throw new Error("deactivateShop requires shopDomain");

  const rows = await sql`
    UPDATE shops
    SET
      active = false,
      uninstalled_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Updates last_synced_at for a shop.
 * @param {string} shopDomain
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function updateLastSynced(shopDomain) {
  const id = String(shopDomain || "").trim();
  if (!id) throw new Error("updateLastSynced requires shopDomain");

  const rows = await sql`
    UPDATE shops
    SET last_synced_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] || null;
}

