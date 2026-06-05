import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { dispatchPendingOutboxEvents } from "../../workers/outboxDispatcherWorker.js";
import { enqueueOutboxDispatcherSchedulerTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "outbox-dispatcher-scheduler";
const POLL_INTERVAL_MS = Number.parseInt(process.env.OUTBOX_DISPATCHER_POLL_INTERVAL_MS || "5000", 10);
const OUTBOX_DISPATCH_BATCH = Number.parseInt(process.env.OUTBOX_DISPATCH_BATCH || "50", 10);
const LEADER_LOCK_KEY = "leader:outbox-dispatcher-scheduler:register";
const LEADER_LOCK_TTL_MS = 45_000;

async function runOutboxDispatchTick(job) {
  const shop = String(job?.data?.shop || "").trim();
  if (!shop) {
    throw new Error("outbox dispatcher tick requires shop");
  }
  try {
    await dispatchPendingOutboxEvents({ shop, limit: OUTBOX_DISPATCH_BATCH });
  } catch (error) {
    logger.error("Outbox dispatcher tick failed", {
      error: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
}

export const outboxDispatcherSchedulerWorker = new Worker(
  QUEUE_NAME,
  async (job) => runOutboxDispatchTick(job),
  { connection, concurrency: 1 },
);
outboxDispatcherSchedulerWorker.on("error", (error) => {
  logger.error("Outbox dispatcher scheduler worker error", {
    error: error?.message,
    stack: error?.stack,
  });
});

export async function registerOutboxDispatcherSchedulerTick({ shop }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("outbox dispatcher registration requires shop");
  }
  const leaderLock = await acquireRedisLock({
    connection,
    key: `${LEADER_LOCK_KEY}:${scopedShop}`,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueOutboxDispatcherSchedulerTick({
      queueName: QUEUE_NAME,
      shop: scopedShop,
      repeatEveryMs: POLL_INTERVAL_MS,
    });
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

export default outboxDispatcherSchedulerWorker;
