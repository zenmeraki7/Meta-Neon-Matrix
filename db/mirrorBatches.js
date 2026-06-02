import sql from "./client.js";

/**
 * Creates a BUILDING mirror batch.
 * @param {{ shopId: string, source: "FULL_SYNC"|"RECONCILIATION", jobId?: string|null }} params
 * @returns {Promise<object>}
 * @throws {Error}
 */
export async function createBatch({ shopId, source, jobId = null }) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedSource = String(source || "").trim();
  if (!resolvedShopId) throw new Error("createBatch requires shopId");
  if (!resolvedSource) throw new Error("createBatch requires source");

  const rows = await sql`
    INSERT INTO mirror_batches (shop_id, status, source, job_id)
    VALUES (${resolvedShopId}, 'BUILDING', ${resolvedSource}, ${jobId ? `${jobId}` : null}::uuid)
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Activates a batch and atomically supersedes prior active batch + updates shop pointers.
 * @param {string} batchId
 * @param {{ productCount: number, variantCount: number }} counts
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function activateBatch(batchId, { productCount, variantCount }) {
  const resolvedBatchId = String(batchId || "").trim();
  if (!resolvedBatchId) throw new Error("activateBatch requires batchId");
  const products = Number(productCount || 0);
  const variants = Number(variantCount || 0);

  const [current] = await sql`SELECT * FROM mirror_batches WHERE id = ${resolvedBatchId}::uuid LIMIT 1`;
  if (!current) return null;
  const shopId = String(current.shop_id);

  await sql.transaction((txn) => [
    txn`
      UPDATE mirror_batches
      SET status = 'SUPERSEDED'
      WHERE shop_id = ${shopId}
        AND status = 'ACTIVE'
        AND id <> ${resolvedBatchId}::uuid
    `,
    txn`
      UPDATE mirror_batches
      SET
        status = 'ACTIVE',
        activated_at = now(),
        product_count = ${products},
        variant_count = ${variants}
      WHERE id = ${resolvedBatchId}::uuid
    `,
    txn`
      UPDATE shops
      SET
        active_mirror_batch_id = ${resolvedBatchId}::uuid,
        mirror_product_count = ${products}
      WHERE id = ${shopId}
    `,
  ]);

  const rows = await sql`SELECT * FROM mirror_batches WHERE id = ${resolvedBatchId}::uuid LIMIT 1`;
  return rows[0] || null;
}

/**
 * Marks a batch FAILED.
 * @param {string} batchId
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function failBatch(batchId) {
  const resolvedBatchId = String(batchId || "").trim();
  if (!resolvedBatchId) throw new Error("failBatch requires batchId");
  const rows = await sql`
    UPDATE mirror_batches
    SET status = 'FAILED'
    WHERE id = ${resolvedBatchId}::uuid
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Returns ACTIVE batch for a shop.
 * @param {string} shopId
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function getActiveBatch(shopId) {
  const resolvedShopId = String(shopId || "").trim();
  if (!resolvedShopId) throw new Error("getActiveBatch requires shopId");
  const rows = await sql`
    SELECT *
    FROM mirror_batches
    WHERE shop_id = ${resolvedShopId}
      AND status = 'ACTIVE'
    ORDER BY activated_at DESC NULLS LAST, started_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

