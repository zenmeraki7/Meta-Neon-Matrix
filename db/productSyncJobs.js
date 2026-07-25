import sql from "./client.js";

/**
 * Attempts to reserve product for a sync job; returns false if already reserved.
 * @param {string} shopDomain
 * @param {bigint|string|number} productId
 * @param {string} jobId
 * @returns {Promise<boolean>}
 * @throws {Error}
 */
export async function coalesceSyncJob(shopDomain, productId, jobId) {
  const resolvedShopDomain = String(shopDomain || "").trim();
  const resolvedProductId = BigInt(productId).toString();
  const resolvedJobId = String(jobId || "").trim();
  if (!resolvedShopDomain) throw new Error("coalesceSyncJob requires shopDomain");
  if (!resolvedJobId) throw new Error("coalesceSyncJob requires jobId");

  const rows = await sql`
    INSERT INTO product_sync_jobs (shop_id, product_id, job_id)
    VALUES (${resolvedShopDomain}, ${resolvedProductId}::bigint, ${resolvedJobId}::uuid)
    ON CONFLICT (shop_id, product_id) DO NOTHING
    RETURNING shop_id
  `;
  return rows.length > 0;
}

/**
 * Clears product sync reservation.
 * @param {string} shopDomain
 * @param {bigint|string|number} productId
 * @returns {Promise<void>}
 * @throws {Error}
 */
export async function clearSyncJob(shopDomain, productId) {
  const resolvedShopDomain = String(shopDomain || "").trim();
  const resolvedProductId = BigInt(productId).toString();
  if (!resolvedShopDomain) throw new Error("clearSyncJob requires shopDomain");

  await sql`
    DELETE FROM product_sync_jobs
    WHERE shop_id = ${resolvedShopDomain}
      AND product_id = ${resolvedProductId}::bigint
  `;
}

