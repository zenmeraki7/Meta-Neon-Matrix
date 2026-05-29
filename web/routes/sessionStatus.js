import express from "express";
import { getScoped } from "../db/bulkEditSessions.js";
import { getStatusCounts } from "../db/bulkEditChanges.js";

const router = express.Router();
const TERMINAL_STATUSES = new Set(["DONE", "PARTIAL", "FAILED"]);

/**
 * Loads session progress scoped to shop.
 * @param {string} shopId
 * @param {string} sessionId
 * @returns {Promise<any|null>}
 */
async function getSessionWithProgress(shopId, sessionId) {
  const session = await getScoped(sessionId, shopId);
  if (!session) return null;

  const counts = await getStatusCounts(sessionId, shopId);

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

/**
 * Writes an SSE event frame.
 * @param {import("express").Response} res
 * @param {string} event
 * @param {Record<string, any>} data
 * @returns {void}
 */
function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

/**
 * GET /api/sessions/:id/status (SSE)
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @returns {Promise<void>}
 */
async function sessionStatusHandler(req, res) {
  const shopId = String(res.locals.shop || "").trim();
  const sessionId = String(req.params.id || "").trim();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  if (!shopId || !sessionId) {
    sendEvent(res, "error", { error: "Session not found" });
    res.end();
    return;
  }

  let pollTimer = null;
  let heartbeatTimer = null;
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };

  req.on("close", () => {
    cleanup();
  });

  try {
    const initial = await getSessionWithProgress(shopId, sessionId);
    if (!initial) {
      sendEvent(res, "error", { error: "Session not found" });
      cleanup();
      res.end();
      return;
    }

    sendEvent(res, "progress", {
      status: initial.status,
      changeCount: Number(initial.change_count || 0),
      writtenCount: Number(initial.written_count || 0),
      errorCount: Number(initial.error_count || 0),
    });

    if (TERMINAL_STATUSES.has(String(initial.status || ""))) {
      sendEvent(res, "done", {});
      cleanup();
      res.end();
      return;
    }

    pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const session = await getSessionWithProgress(shopId, sessionId);
        if (!session) {
          sendEvent(res, "error", { error: "Session not found" });
          cleanup();
          res.end();
          return;
        }

        sendEvent(res, "progress", {
          status: session.status,
          changeCount: Number(session.change_count || 0),
          writtenCount: Number(session.written_count || 0),
          errorCount: Number(session.error_count || 0),
        });

        if (TERMINAL_STATUSES.has(String(session.status || ""))) {
          sendEvent(res, "done", {});
          cleanup();
          res.end();
        }
      } catch (error) {
        sendEvent(res, "error", { error: error?.message || "Failed to stream status" });
        cleanup();
        res.end();
      }
    }, 1500);

    heartbeatTimer = setInterval(() => {
      if (closed) return;
      res.write(": heartbeat\n\n");
    }, 15000);
  } catch (error) {
    sendEvent(res, "error", { error: error?.message || "Failed to stream status" });
    cleanup();
    res.end();
  }
}

router.get("/:id/status", sessionStatusHandler);

export default router;
