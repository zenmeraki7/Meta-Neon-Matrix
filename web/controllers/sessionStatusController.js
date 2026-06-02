import { getSessionProgress } from "../useCases/sessionQueryUseCases.js";

const TERMINAL_STATUSES = new Set(["DONE", "PARTIAL", "FAILED"]);

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function writeProgressEvent(res, session) {
  sendEvent(res, "progress", {
    status: session.status,
    changeCount: Number(session.change_count || 0),
    writtenCount: Number(session.written_count || 0),
    errorCount: Number(session.error_count || 0),
  });
}

export async function sessionStatusStreamController(req, res) {
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

  req.on("close", cleanup);

  try {
    const initial = await getSessionProgress({ shop: shopId, sessionId });
    if (!initial) {
      sendEvent(res, "error", { error: "Session not found" });
      cleanup();
      res.end();
      return;
    }

    writeProgressEvent(res, initial);

    if (TERMINAL_STATUSES.has(String(initial.status || ""))) {
      sendEvent(res, "done", {});
      cleanup();
      res.end();
      return;
    }

    pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const session = await getSessionProgress({ shop: shopId, sessionId });
        if (!session) {
          sendEvent(res, "error", { error: "Session not found" });
          cleanup();
          res.end();
          return;
        }

        writeProgressEvent(res, session);
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
      if (!closed) res.write(": heartbeat\n\n");
    }, 15000);
  } catch (error) {
    sendEvent(res, "error", { error: error?.message || "Failed to stream status" });
    cleanup();
    res.end();
  }
}
