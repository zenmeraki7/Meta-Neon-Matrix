import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";

export async function commitSessionAtomically(sessionId, shopDomain) {
  const resolvedSessionId = String(sessionId || "").trim();
  const resolvedShopDomain = requireShopScope(shopDomain, "shopDomain");

  if (!resolvedSessionId) {
    const error = new Error("Session not found");
    error.statusCode = 404;
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }

  return prisma.$transaction(async (tx) => {
    const sessionRows = await tx.$queryRaw`
      SELECT id, status
      FROM bulk_edit_sessions
      WHERE id = ${resolvedSessionId}::uuid
        AND shop_id = ${resolvedShopDomain}
      LIMIT 1
    `;
    const session = sessionRows[0] || null;
    if (!session) {
      const error = new Error("Session not found");
      error.statusCode = 404;
      error.code = "SESSION_NOT_FOUND";
      throw error;
    }
    if (String(session.status) !== "DRAFT") {
      const error = new Error("Session is not open");
      error.statusCode = 409;
      error.code = "SESSION_NOT_OPEN";
      throw error;
    }

    const countRows = await tx.$queryRaw`
      SELECT COUNT(*)::int AS count
      FROM bulk_edit_changes
      WHERE session_id = ${resolvedSessionId}::uuid
        AND shop_id = ${resolvedShopDomain}
        AND status = 'PENDING'
    `;
    const pendingCount = Number(countRows[0]?.count || 0);
    if (pendingCount === 0) {
      const error = new Error("No pending changes to commit");
      error.statusCode = 422;
      error.code = "NO_PENDING_CHANGES";
      throw error;
    }

    const updatedRows = await tx.$queryRaw`
      UPDATE bulk_edit_sessions
      SET status = 'COMMITTED',
          updated_at = now()
      WHERE id = ${resolvedSessionId}::uuid
        AND shop_id = ${resolvedShopDomain}
        AND status = 'DRAFT'
      RETURNING id
    `;
    if (!Array.isArray(updatedRows) || updatedRows.length !== 1) {
      const error = new Error("Session is not open");
      error.statusCode = 409;
      error.code = "SESSION_NOT_OPEN";
      throw error;
    }

    return {
      sessionId: resolvedSessionId,
      shopDomain: resolvedShopDomain,
      changeCount: pendingCount,
    };
  });
}
