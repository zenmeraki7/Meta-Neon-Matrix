import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { scheduleDueScheduledExportRuns } from "../../services/scheduledExportExecutionService.js";
import {
  purgeExpiredFilterTracks,
  purgeExpiredIdempotencyRecords,
} from "../../services/filterTrackCleanupService.js";
import logger from "../../utils/loggerUtils.js";
import { enqueueScheduledExportSchedulerTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "scheduled-export-scheduler";
const SCHEDULE_INTERVAL_MS = 10_000;
const FILTER_TRACK_PURGE_INTERVAL_MS = 5 * 60 * 1000;
const LEADER_LOCK_KEY = "leader:scheduled-export-scheduler:register";
const LEADER_LOCK_TTL_MS = 45_000;
let lastFilterTrackPurgeAt = 0;

async function runSchedulerTick(job) {
  const shop = String(job?.data?.shop || "").trim();
  if (!shop) {
    throw new Error("scheduled export scheduler tick requires shop");
  }
  try {
    await scheduleDueScheduledExportRuns({ shop });
    const now = Date.now();
    if (now - lastFilterTrackPurgeAt >= FILTER_TRACK_PURGE_INTERVAL_MS) {
      lastFilterTrackPurgeAt = now;
      await Promise.all([
        purgeExpiredFilterTracks({ shop, limit: 2000 }),
        purgeExpiredIdempotencyRecords({ shop, limit: 2000 }),
      ]);
    }
  } catch (error) {
    logger.error("Scheduled export scheduler tick failed", {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

export const scheduledExportSchedulerWorker = new Worker(
  QUEUE_NAME,
  async (job) => runSchedulerTick(job),
  { connection, concurrency: 1 },
);
scheduledExportSchedulerWorker.on("error", (error) => {
  logger.error("Scheduled export scheduler worker error", {
    error: error?.message,
    stack: error?.stack,
  });
});

export async function registerScheduledExportSchedulerTick({
  shop,
  enqueueSchedulerTick = enqueueScheduledExportSchedulerTick,
  repeatEveryMs = SCHEDULE_INTERVAL_MS,
}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("scheduled export scheduler registration requires shop");
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

export default scheduledExportSchedulerWorker;
