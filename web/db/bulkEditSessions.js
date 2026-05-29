import { prisma } from "../config/database.js";

/**
 * Creates a bulk edit session.
 * @param {{ shop: string, filterParams?: object, variantCount?: number }} input
 * @returns {Promise<object>}
 */
export async function createSession({ shop, filterParams = {}, variantCount = 0 }) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) {
    throw new Error("createSession requires shop");
  }

  const rows = await prisma.$queryRaw`
    INSERT INTO bulk_edit_sessions (
      shop_id,
      status,
      filter_params,
      variant_count,
      created_at,
      updated_at
    ) VALUES (
      ${resolvedShop},
      'OPEN',
      ${JSON.stringify(filterParams || {})}::jsonb,
      ${Number(variantCount || 0)},
      now(),
      now()
    )
    RETURNING *
  `;
  return rows[0] || null;
}

/**
 * Gets a session by id scoped to shop.
 * @param {string} sessionId
 * @param {string} shop
 * @returns {Promise<object|null>}
 */
export async function getSession(sessionId, shop) {
  const resolvedId = String(sessionId || "").trim();
  const resolvedShop = String(shop || "").trim();
  if (!resolvedId || !resolvedShop) return null;

  const rows = await prisma.$queryRaw`
    SELECT *
    FROM bulk_edit_sessions
    WHERE id = ${resolvedId}::uuid
      AND shop_id = ${resolvedShop}
    LIMIT 1
  `;
  return rows[0] || null;
}

/**
 * Gets a session by id scoped to shop (canonical alias).
 * @param {string} sessionId
 * @param {string} shop
 * @returns {Promise<object|null>}
 */
export async function getScoped(sessionId, shop) {
  return getSession(sessionId, shop);
}

/**
 * Marks a session as committing.
 * @param {{ sessionId: string, shop: string, changeCount: number }} input
 * @returns {Promise<number>}
 */
export async function markSessionCommitting({ sessionId, shop, changeCount }) {
  const resolvedId = String(sessionId || "").trim();
  const resolvedShop = String(shop || "").trim();
  if (!resolvedId || !resolvedShop) {
    throw new Error("markSessionCommitting requires sessionId and shop");
  }

  const rows = await prisma.$queryRaw`
    UPDATE bulk_edit_sessions
    SET
      status = 'COMMITTING',
      change_count = ${Number(changeCount || 0)},
      updated_at = now()
    WHERE id = ${resolvedId}::uuid
      AND shop_id = ${resolvedShop}
    RETURNING id
  `;
  return rows.length;
}

/**
 * Updates terminal session status.
 * @param {{ sessionId: string, shop: string, status: "DONE"|"PARTIAL"|"FAILED", writtenCount?: number, errorCount?: number }} input
 * @returns {Promise<number>}
 */
export async function finalizeSession({
  sessionId,
  shop,
  status,
  writtenCount = 0,
  errorCount = 0,
}) {
  const resolvedId = String(sessionId || "").trim();
  const resolvedShop = String(shop || "").trim();
  const resolvedStatus = String(status || "").trim().toUpperCase();
  if (!resolvedId || !resolvedShop) {
    throw new Error("finalizeSession requires sessionId and shop");
  }
  if (!["DONE", "PARTIAL", "FAILED"].includes(resolvedStatus)) {
    throw new Error("finalizeSession requires terminal status");
  }

  const rows = await prisma.$queryRaw`
    UPDATE bulk_edit_sessions
    SET
      status = ${resolvedStatus},
      written_count = ${Number(writtenCount || 0)},
      error_count = ${Number(errorCount || 0)},
      completed_at = now(),
      updated_at = now()
    WHERE id = ${resolvedId}::uuid
      AND shop_id = ${resolvedShop}
    RETURNING id
  `;
  return rows.length;
}
