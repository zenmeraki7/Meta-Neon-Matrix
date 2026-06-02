import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { scheduleDueScheduledExportRuns } from "../../services/scheduledExportExecutionService.js";
import { purgeExpiredFilterTracks } from "../../services/filterTrackCleanupService.js";
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

async function runSchedulerTick() {
  try {
    await scheduleDueScheduledExportRuns();
    const now = Date.now();
    if (now - lastFilterTrackPurgeAt >= FILTER_TRACK_PURGE_INTERVAL_MS) {
      lastFilterTrackPurgeAt = now;
      await purgeExpiredFilterTracks({ limit: 2000 });
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
  async () => runSchedulerTick(),
  { connection, concurrency: 1 },
);
scheduledExportSchedulerWorker.on("error", (error) => {
  logger.error("Scheduled export scheduler worker error", {
    error: error?.message,
    stack: error?.stack,
  });
});

async function registerRepeatableTick() {
  const leaderLock = await acquireRedisLock({
    connection,
    key: LEADER_LOCK_KEY,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueScheduledExportSchedulerTick(SCHEDULE_INTERVAL_MS);
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

await registerRepeatableTick();

export default scheduledExportSchedulerWorker;
