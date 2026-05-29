import sql from "./client.js";

/**
 * Attempts to reserve product for a sync job; returns false if already reserved.
 * @param {string} shopId
 * @param {bigint|string|number} productId
 * @param {string} jobId
 * @returns {Promise<boolean>}
 * @throws {Error}
 */
export async function coalesceSyncJob(shopId, productId, jobId) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedProductId = BigInt(productId).toString();
  const resolvedJobId = String(jobId || "").trim();
  if (!resolvedShopId) throw new Error("coalesceSyncJob requires shopId");
  if (!resolvedJobId) throw new Error("coalesceSyncJob requires jobId");

  const rows = await sql`
    INSERT INTO product_sync_jobs (shop_id, product_id, job_id)
    VALUES (${resolvedShopId}, ${resolvedProductId}::bigint, ${resolvedJobId}::uuid)
    ON CONFLICT (shop_id, product_id) DO NOTHING
    RETURNING shop_id
  `;
  return rows.length > 0;
}

/**
 * Clears product sync reservation.
 * @param {string} shopId
 * @param {bigint|string|number} productId
 * @returns {Promise<void>}
 * @throws {Error}
 */
export async function clearSyncJob(shopId, productId) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedProductId = BigInt(productId).toString();
  if (!resolvedShopId) throw new Error("clearSyncJob requires shopId");

  await sql`
    DELETE FROM product_sync_jobs
    WHERE shop_id = ${resolvedShopId}
      AND product_id = ${resolvedProductId}::bigint
  `;
}

