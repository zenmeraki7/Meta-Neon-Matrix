import { createSession, getScoped } from "../db/bulkEditSessions.js";
import {
  discardPendingChanges,
  getErrorVariantIdsForColumn,
  getColumnErrorSummary,
  getSessionPreview,
  getStatusCounts,
} from "../db/bulkEditChanges.js";

export async function createBulkEditSession({ shop, filterParams, variantCount }) {
  const resolvedShop = String(shop || "").trim();
  if (!resolvedShop) {
    const error = new Error("Unauthenticated session");
    error.statusCode = 401;
    throw error;
  }

  const resolvedVariantCount = Number(variantCount || 0);
  if (!(resolvedVariantCount > 0)) {
    const error = new Error("Validation failed");
    error.statusCode = 400;
    error.fields = [{ field: "variantCount", error: "must be > 0" }];
    throw error;
  }

  return createSession({
    shop: resolvedShop,
    filterParams,
    variantCount: resolvedVariantCount,
  });
}

export async function getSessionById({ shop, sessionId }) {
  const resolvedShop = String(shop || "").trim();
  const resolvedSessionId = String(sessionId || "").trim();
  if (!resolvedShop || !resolvedSessionId) return null;
  return getScoped(resolvedSessionId, resolvedShop);
}

export async function getSessionPreviewById({ shop, sessionId }) {
  const session = await getSessionById({ shop, sessionId });
  if (!session) return null;
  return getSessionPreview(String(sessionId), String(shop));
}

export async function getSessionColumnErrors({ shop, sessionId }) {
  const session = await getSessionById({ shop, sessionId });
  if (!session) return null;
  return getColumnErrorSummary(String(sessionId), String(shop));
}

export async function getSessionColumnVariantErrors({ shop, sessionId, namespace, key }) {
  const session = await getSessionById({ shop, sessionId });
  if (!session) {
    const error = new Error("Session not found");
    error.statusCode = 404;
    throw error;
  }
  const resolvedNamespace = String(namespace || "").trim();
  const resolvedKey = String(key || "").trim();
  if (!resolvedNamespace || !resolvedKey) {
    const error = new Error("namespace and key are required");
    error.statusCode = 400;
    throw error;
  }
  const variantIds = await getErrorVariantIdsForColumn(
    String(sessionId),
    String(shop),
    resolvedNamespace,
    resolvedKey,
  );
  return { namespace: resolvedNamespace, key: resolvedKey, variantIds };
}

export async function discardSessionPendingChanges({ shop, sessionId }) {
  const session = await getSessionById({ shop, sessionId });
  if (!session) {
    const error = new Error("Session not found");
    error.statusCode = 404;
    throw error;
  }
  if (String(session.status || "") !== "DRAFT") {
    const error = new Error("Session is not open");
    error.statusCode = 409;
    error.code = "SESSION_NOT_OPEN";
    throw error;
  }
  return discardPendingChanges(String(sessionId), String(shop));
}

export async function getSessionProgress({ shop, sessionId }) {
  const session = await getSessionById({ shop, sessionId });
  if (!session) return null;

  const counts = await getStatusCounts(String(sessionId), String(shop));
  let changeCount = 0;
  let writtenCount = 0;
  let errorCount = 0;

  for (const row of counts) {
    const status = String(row.status || "").toUpperCase();
    const count = Number(row.count || 0);
    changeCount += count;
    if (status === "WRITTEN") writtenCount += count;
    if (status === "ERROR") errorCount += count;
  }

  return {
    ...session,
    change_count: changeCount,
    written_count: writtenCount,
    error_count: errorCount,
  };
}
