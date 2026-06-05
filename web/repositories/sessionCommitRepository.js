import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";

function serviceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function countPendingChanges(tx, sessionId, shopId) {
  const countRows = await tx.$queryRaw`
    SELECT COUNT(*)::int AS count
    FROM bulk_edit_changes
    WHERE session_id = ${sessionId}::uuid
      AND shop_id = ${shopId}
      AND status = 'PENDING'
  `;
  return Number(countRows[0]?.count || 0);
}

export async function commitSessionAtomically(sessionId, shopId) {
  const resolvedSessionId = String(sessionId || "").trim();
  const resolvedShopId = requireShopScope(shopId, "shopId");

  if (!resolvedSessionId) {
    throw serviceError("Session not found", "SESSION_NOT_FOUND");
  }

  return prisma.$transaction(async (tx) => {
    const sessionRows = await tx.$queryRaw`
      SELECT id, status
      FROM bulk_edit_sessions
      WHERE id = ${resolvedSessionId}::uuid
        AND shop_id = ${resolvedShopId}
      LIMIT 1
    `;
    const session = sessionRows[0] || null;
    if (!session) {
      throw serviceError("Session not found", "SESSION_NOT_FOUND");
    }
    if (session.status === null || session.status === undefined) {
      throw serviceError("Session status is invalid", "SESSION_STATUS_INVALID");
    }
    const status = String(session.status).trim().toUpperCase();
    if (status === "COMMITTED") {
      return {
        sessionId: resolvedSessionId,
        shopId: resolvedShopId,
        changeCount: await countPendingChanges(tx, resolvedSessionId, resolvedShopId),
        alreadyCommitted: true,
      };
    }
    if (status !== "DRAFT") {
      throw serviceError("Session is not open", "SESSION_NOT_OPEN");
    }

    const pendingCount = await countPendingChanges(tx, resolvedSessionId, resolvedShopId);
    if (pendingCount === 0) {
      throw serviceError("No pending changes to commit", "NO_PENDING_CHANGES");
    }

    const updatedRows = await tx.$queryRaw`
      UPDATE bulk_edit_sessions
      SET status = 'COMMITTED',
          updated_at = now()
      WHERE id = ${resolvedSessionId}::uuid
        AND shop_id = ${resolvedShopId}
        AND status = 'DRAFT'
      RETURNING id
    `;
    if (!Array.isArray(updatedRows) || updatedRows.length !== 1) {
      throw serviceError("Session is not open", "SESSION_NOT_OPEN");
    }

    return {
      sessionId: resolvedSessionId,
      shopId: resolvedShopId,
      changeCount: pendingCount,
    };
  });
}
