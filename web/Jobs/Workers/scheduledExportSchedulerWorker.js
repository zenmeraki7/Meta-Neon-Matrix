import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { scheduleDueScheduledExportRuns } from "../../services/scheduledExportExecutionService.js";
import { purgeExpiredFilterTracks } from "../../services/filterTrackCleanupService.js";
import logger from "../../utils/loggerUtils.js";
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

export const scheduledExportSchedulerQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

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
  }
}

export const scheduledExportSchedulerWorker = new Worker(
  QUEUE_NAME,
  async () => runSchedulerTick(),
  { connection, concurrency: 1 },
);

async function registerRepeatableTick() {
  const leaderLock = await acquireRedisLock({
    connection,
    key: LEADER_LOCK_KEY,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await scheduledExportSchedulerQueue.add(
      "scheduled-export-scheduler-tick",
      {},
      {
        jobId: "scheduled-export-scheduler-tick",
        repeat: { every: SCHEDULE_INTERVAL_MS },
      },
    );
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
