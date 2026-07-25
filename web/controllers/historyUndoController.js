import { randomUUID } from "crypto";
import { productBulkUndoUseCases } from "../useCases/productBulkEditUseCases.js";
import { db } from "../repositories/repositoryDb.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import logger from "../utils/loggerUtils.js";

function requestId(req) {
  return String(req.id || req.get?.("X-Request-Id") || randomUUID());
}

function sessionFrom(res) {
  const session = res.locals?.shopify?.session;
  if (!session?.shop) {
    const error = new Error("Authentication required");
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  return session;
}

function actorFrom(session) {
  const user = session?.onlineAccessInfo?.associated_user;
  return {
    type: user?.id ? "SHOPIFY_USER" : "SHOPIFY_SESSION",
    actorId: user?.id ? String(user.id) : null,
    userId: user?.id ? String(user.id) : null,
    email: user?.email || null,
  };
}

function validateHistoryId(value) {
  const id = String(value || "").trim();
  if (
    !id ||
    id.length < 20 ||
    id.length > 128 ||
    id.includes("...") ||
    !/^[A-Za-z0-9_-]+$/.test(id)
  ) {
    const error = new Error("A full immutable history id is required");
    error.code = "INVALID_HISTORY_ID";
    throw error;
  }
  return id;
}

function validateOperationConfirmation(value, historyId) {
  const operationId = validateHistoryId(value);
  if (operationId !== historyId) {
    const error = new Error("Operation confirmation does not match history");
    error.code = "INVALID_OPERATION_ID";
    throw error;
  }
  return operationId;
}

function isDatabaseFailure(error) {
  return ["P1000", "P1001", "P1002", "P1008", "P1017"].includes(
    String(error?.code || "").toUpperCase()
  );
}

async function sendError({ req, res, error, shop, source }) {
  const safeError = isDatabaseFailure(error)
    ? Object.assign(new Error("Undo database is temporarily unavailable"), {
        code: "DATABASE_UNAVAILABLE",
      })
    : error;
  await logApiError({
    shop,
    err: safeError,
    req: {
      method: req.method,
      path: req.path,
      requestId: requestId(req),
    },
    source,
  });
  const { statusCode, body } = buildPublicApiErrorResponse(
    safeError,
    "INTERNAL_ERROR"
  );
  return res.status(statusCode).json(body);
}

export async function requestHistoryUndo(req, res) {
  let session;
  const reqId = requestId(req);
  const startedAt = Date.now();
  try {
    res.set("Cache-Control", "no-store");
    session = sessionFrom(res);
    const historyId = validateHistoryId(req.params?.historyId);
    const confirmationOperationId = validateOperationConfirmation(
      req.body?.confirmationOperationId,
      historyId
    );
    logger.info("undo.http.received", {
      requestId: reqId,
      originalHistoryId: historyId,
    });
    logger.info("undo.http.authenticated", {
      requestId: reqId,
      shop: session.shop,
    });

    const result = await productBulkUndoUseCases.undo({
      shop: session.shop,
      accessToken: session.accessToken || null,
      oauthScopes: session.scope || null,
      actor: actorFrom(session),
      historyId,
      confirmationOperationId,
      idempotencyKey: String(
        req.get?.("Idempotency-Key") || `undo:${historyId}`
      ),
      subscription: req.subscription || null,
      entitlement: req.entitlement || null,
      activePlan: req.activePlan || {},
    });

    logger.info("undo.http.claimed", {
      requestId: reqId,
      shop: session.shop,
      originalHistoryId: historyId,
      undoExecutionId: result.undoExecutionId,
      durationMs: Date.now() - startedAt,
    });
    return res.status(202).json(result);
  } catch (error) {
    return sendError({
      req,
      res,
      error,
      shop: session?.shop,
      source: "historyUndoController.requestHistoryUndo",
    });
  }
}

export async function getHistoryUndoStatus(req, res) {
  let session;
  try {
    res.set("Cache-Control", "no-store");
    session = sessionFrom(res);
    const undoExecutionId = validateHistoryId(req.params?.undoExecutionId);
    const operation = await db.undoOperation.findFirst({
      where: { id: undoExecutionId, shop: session.shop },
      select: {
        id: true,
        executionState: true,
        totalEligibleCount: true,
        restoredCount: true,
        failedCount: true,
        skippedCount: true,
        conflictedCount: true,
        processedCount: true,
        failureCode: true,
        failureMessage: true,
        updatedAt: true,
      },
    });
    if (!operation) {
      const error = new Error("Undo execution not found");
      error.code = "UNDO_EXECUTION_NOT_FOUND";
      throw error;
    }
    const terminal = [
      "completed",
      "partially_completed",
      "partial",
      "failed",
      "cancelled",
    ].includes(String(operation.executionState || "").toLowerCase());
    const accounted =
      operation.restoredCount +
      operation.failedCount +
      operation.skippedCount +
      operation.conflictedCount;
    return res.status(200).json({
      ok: true,
      undoExecutionId: operation.id,
      status: String(operation.executionState || "queued").toUpperCase(),
      terminal,
      counts: {
        total: operation.totalEligibleCount,
        restored: operation.restoredCount,
        failed: operation.failedCount,
        skipped: operation.skippedCount,
        conflicted: operation.conflictedCount,
        remaining: Math.max(operation.totalEligibleCount - accounted, 0),
      },
      error: operation.failureCode
        ? {
            code: operation.failureCode,
            message: operation.failureMessage || "Undo failed",
          }
        : null,
      updatedAt: operation.updatedAt,
    });
  } catch (error) {
    return sendError({
      req,
      res,
      error,
      shop: session?.shop,
      source: "historyUndoController.getHistoryUndoStatus",
    });
  }
}
