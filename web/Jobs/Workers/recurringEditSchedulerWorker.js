import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { scheduleDueRecurringEditRuns } from "../../services/recurringEditExecutionService.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "recurring-edit-scheduler";
const POLL_INTERVAL_MS = 60_000;
const LEADER_LOCK_KEY = "leader:recurring-edit-scheduler:register";
const LEADER_LOCK_TTL_MS = 45_000;

export const recurringEditSchedulerQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 24 * 3600, count: 500 },
  },
});

async function runSchedulerTick() {
  try {
    await scheduleDueRecurringEditRuns();
  } catch (error) {
    logger.error("Recurring edit scheduler tick failed", {
      error: error.message,
      stack: error.stack,
    });
  }
}

export const recurringEditSchedulerWorker = new Worker(
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
    await recurringEditSchedulerQueue.add(
      "recurring-edit-scheduler-tick",
      {},
      {
        jobId: "recurring-edit-scheduler-tick",
        repeat: { every: POLL_INTERVAL_MS },
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

export default recurringEditSchedulerWorker;
