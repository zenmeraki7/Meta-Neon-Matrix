import logger from "../../utils/loggerUtils.js";
import { dispatchPendingOutboxEvents } from "../../workers/outboxDispatcherWorker.js";

const POLL_INTERVAL_MS = Number.parseInt(process.env.OUTBOX_DISPATCHER_POLL_INTERVAL_MS || "5000", 10);
const OUTBOX_DISPATCH_BATCH = Number.parseInt(process.env.OUTBOX_DISPATCH_BATCH || "50", 10);

async function runOutboxDispatchTick() {
  try {
    await dispatchPendingOutboxEvents({ limit: OUTBOX_DISPATCH_BATCH });
  } catch (error) {
    logger.error("Outbox dispatcher tick failed", {
      error: error?.message,
      stack: error?.stack,
    });
  }
}

if (!globalThis.__outboxDispatcherStarted) {
  globalThis.__outboxDispatcherStarted = true;
  setInterval(runOutboxDispatchTick, POLL_INTERVAL_MS);
  setTimeout(runOutboxDispatchTick, 3_000);
}

export default {
  pollIntervalMs: POLL_INTERVAL_MS,
};
