import { Queue, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import { dispatchPendingOutboxEvents } from "../../workers/outboxDispatcherWorker.js";
import {
  acquireRedisLock,
  releaseRedisLock,
} from "../../utils/redisLockUtils.js";

const QUEUE_NAME = "outbox-dispatcher-scheduler";
const POLL_INTERVAL_MS = Number.parseInt(process.env.OUTBOX_DISPATCHER_POLL_INTERVAL_MS || "5000", 10);
const OUTBOX_DISPATCH_BATCH = Number.parseInt(process.env.OUTBOX_DISPATCH_BATCH || "50", 10);
const LEADER_LOCK_KEY = "leader:outbox-dispatcher-scheduler:register";
const LEADER_LOCK_TTL_MS = 45_000;

export const outboxDispatcherSchedulerQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 3600, count: 500 },
    removeOnFail: { age: 24 * 3600, count: 1000 },
  },
});

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

export const outboxDispatcherSchedulerWorker = new Worker(
  QUEUE_NAME,
  async () => runOutboxDispatchTick(),
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
    await outboxDispatcherSchedulerQueue.add(
      "outbox-dispatcher-scheduler-tick",
      {},
      {
        jobId: "outbox-dispatcher-scheduler-tick",
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

export default outboxDispatcherSchedulerWorker;
