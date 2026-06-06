import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { dispatchPendingOutboxEvents } from "../../services/outboxDispatchService.js";
import { enqueueOutboxDispatcherSchedulerTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";

const QUEUE_NAME = "outbox-dispatcher-scheduler";
const POLL_INTERVAL_MS = Number.parseInt(process.env.OUTBOX_DISPATCHER_POLL_INTERVAL_MS || "5000", 10);
const OUTBOX_DISPATCH_BATCH = Number.parseInt(process.env.OUTBOX_DISPATCH_BATCH || "50", 10);

async function runOutboxDispatchTick(job) {
  const shop = String(job?.data?.shop || "").trim();
  if (!shop) {
    throw new Error("outbox dispatcher tick requires shop");
  }
  try {
    const result = await dispatchPendingOutboxEvents({
      shop,
      limit: OUTBOX_DISPATCH_BATCH,
    });
    logger.info("Outbox dispatcher tick completed", {
      worker: "outboxDispatcherWorker",
      queue: QUEUE_NAME,
      jobId: job?.id,
      shop,
      ...result,
    });
    return result;
  } catch (error) {
    logger.error("Outbox dispatcher tick failed", {
      worker: "outboxDispatcherWorker",
      queue: QUEUE_NAME,
      jobId: job?.id,
      shop,
      attemptsMade: job?.attemptsMade,
      message: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
}

export const outboxDispatcherSchedulerWorker = new Worker(
  QUEUE_NAME,
  async (job) => runOutboxDispatchTick(job),
  {
    connection,
    concurrency: 1,
    lockDuration: Number(process.env.OUTBOX_DISPATCHER_LOCK_DURATION_MS || 60_000),
    stalledInterval: Number(process.env.OUTBOX_DISPATCHER_STALLED_INTERVAL_MS || 30_000),
    maxStalledCount: Number(process.env.OUTBOX_DISPATCHER_MAX_STALLED_COUNT || 1),
  },
);

outboxDispatcherSchedulerWorker.on("completed", (job, result) => {
  logger.info("Outbox dispatcher worker completed", {
    worker: "outboxDispatcherWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    dispatched: result?.dispatched || 0,
    failed: result?.failed || 0,
    remaining: result?.remaining || 0,
  });
});

outboxDispatcherSchedulerWorker.on("failed", (job, error) => {
  logger.error("Outbox dispatcher worker failed", {
    worker: "outboxDispatcherWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    attemptsMade: job?.attemptsMade,
    message: error?.message,
    stack: error?.stack,
  });
});

outboxDispatcherSchedulerWorker.on("stalled", (jobId) => {
  logger.warn("Outbox dispatcher worker stalled", {
    worker: "outboxDispatcherWorker",
    queue: QUEUE_NAME,
    jobId,
  });
});

outboxDispatcherSchedulerWorker.on("error", (error) => {
  logger.error("Outbox dispatcher scheduler worker error", {
    worker: "outboxDispatcherWorker",
    queue: QUEUE_NAME,
    message: error?.message,
    stack: error?.stack,
  });
});

export async function registerOutboxDispatcherSchedulerTick({ shop }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("outbox dispatcher registration requires shop");
  }
  return enqueueOutboxDispatcherSchedulerTick({
    queueName: QUEUE_NAME,
    shop: scopedShop,
    repeatEveryMs: POLL_INTERVAL_MS,
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await outboxDispatcherSchedulerWorker.close();
  } catch (error) {
    logger.error("Outbox dispatcher worker shutdown failed", {
      worker: "outboxDispatcherWorker",
      queue: QUEUE_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default outboxDispatcherSchedulerWorker;
