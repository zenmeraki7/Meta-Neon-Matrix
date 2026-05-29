import sql from "./client.js";

/**
 * Creates a new sync job row.
 * @param {{ shopId: string, type: "FULL_SYNC"|"INCREMENTAL_SYNC"|"BULK_WRITE", meta?: object }} params
 * @returns {Promise<object>}
 * @throws {Error}
 */
export async function createJob({ shopId, type, meta = {} }) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedType = String(type || "").trim();
  const resolvedMeta = meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};

  if (!resolvedShopId) throw new Error("createJob requires shopId");
  if (!resolvedType) throw new Error("createJob requires type");

  const rows = await sql`
    INSERT INTO sync_jobs (shop_id, type, meta)
    VALUES (${resolvedShopId}, ${resolvedType}, ${JSON.stringify(resolvedMeta)}::jsonb)
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Marks a job RUNNING and stamps started_at.
 * @param {string} jobId
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function startJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("startJob requires jobId");

  const rows = await sql`
    UPDATE sync_jobs
    SET
      status = 'RUNNING',
      started_at = now()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Atomically increments job progress counters.
 * @param {string} jobId
 * @param {{ processed?: number, errors?: number }} increments
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function incrementProgress(jobId, { processed = 0, errors = 0 } = {}) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("incrementProgress requires jobId");

  const processedInc = Number.isFinite(Number(processed)) ? Number(processed) : 0;
  const errorsInc = Number.isFinite(Number(errors)) ? Number(errors) : 0;

  const rows = await sql`
    UPDATE sync_jobs
    SET
      processed_count = processed_count + ${processedInc},
      error_count = error_count + ${errorsInc}
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Marks a job DONE and stamps completed_at.
 * @param {string} jobId
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function completeJob(jobId) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("completeJob requires jobId");

  const rows = await sql`
    UPDATE sync_jobs
    SET
      status = 'DONE',
      completed_at = now()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Marks a job FAILED and stores error message.
 * @param {string} jobId
 * @param {string} errorMessage
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function failJob(jobId, errorMessage) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("failJob requires jobId");

  const message = String(errorMessage || "").trim() || "Unknown error";

  const rows = await sql`
    UPDATE sync_jobs
    SET
      status = 'FAILED',
      completed_at = now(),
      error_message = ${message}
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Gets most recent active job for a shop and type.
 * @param {string} shopId
 * @param {"FULL_SYNC"|"INCREMENTAL_SYNC"|"BULK_WRITE"} type
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function getActiveJob(shopId, type) {
  const resolvedShopId = String(shopId || "").trim();
  const resolvedType = String(type || "").trim();
  if (!resolvedShopId) throw new Error("getActiveJob requires shopId");
  if (!resolvedType) throw new Error("getActiveJob requires type");

  const rows = await sql`
    SELECT *
    FROM sync_jobs
    WHERE shop_id = ${resolvedShopId}
      AND type = ${resolvedType}
      AND status IN ('PENDING', 'RUNNING')
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * Returns latest jobs for a shop.
 * @param {string} shopId
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 * @throws {Error}
 */
export async function getRecentJobs(shopId, limit = 10) {
  const resolvedShopId = String(shopId || "").trim();
  if (!resolvedShopId) throw new Error("getRecentJobs requires shopId");

  const normalizedLimit = Math.max(1, Number.parseInt(String(limit || 10), 10) || 10);

  const rows = await sql`
    SELECT *
    FROM sync_jobs
    WHERE shop_id = ${resolvedShopId}
    ORDER BY created_at DESC
    LIMIT ${normalizedLimit}
  `;
  return rows;
}

/**
 * Merges fields into sync_jobs.meta.
 * @param {string} jobId
 * @param {object} metaPatch
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function updateJobMeta(jobId, metaPatch = {}) {
  const id = String(jobId || "").trim();
  if (!id) throw new Error("updateJobMeta requires jobId");
  const patch = metaPatch && typeof metaPatch === "object" && !Array.isArray(metaPatch)
    ? metaPatch
    : {};

  const rows = await sql`
    UPDATE sync_jobs
    SET meta = COALESCE(meta, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows[0] || null;
}
