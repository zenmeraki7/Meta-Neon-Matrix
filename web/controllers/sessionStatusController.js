import { getSessionProgress } from "../useCases/sessionQueryUseCases.js";
import { isTerminalSessionStatus } from "../constants/sessionStatus.js";
import { toSessionProgressEventDto } from "../dtos/sessionProgressDto.js";
import { normalizeSessionStatusStreamCommand } from "../normalizers/sessionStatusStreamCommandNormalizer.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data || {})}\n\n`);
}

function writeProgressEvent(res, session) {
  sendEvent(res, "progress", toSessionProgressEventDto(session));
}

function writePublicErrorEvent(res, error, fallbackCode = "INTERNAL_ERROR") {
  const { body } = buildPublicApiErrorResponse(error, fallbackCode);
  sendEvent(res, "error", body);
}

export async function sessionStatusStreamController(req, res) {
  let command;
  try {
    command = normalizeSessionStatusStreamCommand(req.params, res.locals);
  } catch (error) {
    await logApiError({
      shop: res.locals?.shopify?.session?.shop,
      err: error,
      req,
      source: "sessionStatusController.sessionStatusStreamController.normalize",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(error, "VALIDATION_FAILED");
    return res.status(statusCode).json(body);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

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
    const initial = await getSessionProgress({
      shop: command.shop,
      sessionId: command.sessionId,
    });
    if (!initial) {
      sendEvent(res, "error", { error: "Session not found" });
      cleanup();
      res.end();
      return;
    }

    writeProgressEvent(res, initial);

    if (isTerminalSessionStatus(initial.status)) {
      sendEvent(res, "done", {});
      cleanup();
      res.end();
      return;
    }

    pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const session = await getSessionProgress({
          shop: command.shop,
          sessionId: command.sessionId,
        });
        if (!session) {
          sendEvent(res, "error", { error: "Session not found" });
          cleanup();
          res.end();
          return;
        }

        writeProgressEvent(res, session);
        if (isTerminalSessionStatus(session.status)) {
          sendEvent(res, "done", {});
          cleanup();
          res.end();
        }
      } catch (error) {
        await logApiError({
          shop: command.shop,
          err: error,
          req,
          source: "sessionStatusController.sessionStatusStreamController.poll",
        });
        writePublicErrorEvent(res, error);
        cleanup();
        res.end();
      }
    }, 1500);

    heartbeatTimer = setInterval(() => {
      if (!closed) res.write(": heartbeat\n\n");
    }, 15000);
  } catch (error) {
    await logApiError({
      shop: command.shop,
      err: error,
      req,
      source: "sessionStatusController.sessionStatusStreamController",
    });
    writePublicErrorEvent(res, error);
    cleanup();
    res.end();
  }
}
