import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { scheduleDueRecurringEditRuns } from "../../services/recurringEditExecutionService.js";
import { enqueueRecurringEditSchedulerTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "recurring-edit-scheduler";
const POLL_INTERVAL_MS = 60_000;
const LEADER_LOCK_KEY = "leader:recurring-edit-scheduler:register";
const LEADER_LOCK_TTL_MS = 45_000;

async function runSchedulerTick(job) {
  const shop = String(job?.data?.shop || "").trim();
  if (!shop) {
    throw new Error("recurring edit scheduler tick requires shop");
  }
  try {
    await scheduleDueRecurringEditRuns({ shop });
  } catch (error) {
    logger.error("Recurring edit scheduler tick failed", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export const recurringEditSchedulerWorker = new Worker(
  QUEUE_NAME,
  async (job) => runSchedulerTick(job),
  { connection, concurrency: 1 },
);
recurringEditSchedulerWorker.on("error", (error) => {
  logger.error("Recurring edit scheduler worker error", {
    error: error?.message,
    stack: error?.stack,
  });
});

export async function registerRecurringEditSchedulerTick({
  shop,
  enqueueSchedulerTick = enqueueRecurringEditSchedulerTick,
  repeatEveryMs = POLL_INTERVAL_MS,
}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("recurring edit scheduler registration requires shop");
  }
  const leaderLock = await acquireRedisLock({
    connection,
    key: `${LEADER_LOCK_KEY}:${scopedShop}`,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueSchedulerTick({ shop: scopedShop, repeatEveryMs });
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

export default recurringEditSchedulerWorker;
