import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import { buildDefaultJobOptions } from "../../utils/jobQueueUtils.js";
import { acquireRedisLock, releaseRedisLock } from "../../utils/redisLockUtils.js";

export const RECONCILIATION_QUEUE_NAME = process.env.RECONCILIATION_QUEUE_NAME || "reconciliation-scheduler";
const LOCK_KEY = "leader:reconciliation-scheduler";
const LOCK_TTL_MS = 45_000;

export const reconciliationQueue = new Queue(RECONCILIATION_QUEUE_NAME, {
  connection,
  defaultJobOptions: buildDefaultJobOptions({
    attempts: 3,
    priority: 6,
    backoffDelay: 5_000,
    removeOnComplete: { age: 7 * 24 * 3600, count: 1_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5_000 },
  }),
});

export async function scheduleReconciliationJob() {
  const repeatEveryMs = Math.max(60_000, Number(process.env.RECONCILIATION_REPEAT_MS || 60 * 60 * 1000));
  const lock = await acquireRedisLock({ connection, key: LOCK_KEY, ttlMs: LOCK_TTL_MS });
  if (!lock.acquired) return null;
  try {
    return reconciliationQueue.add(
      "RECONCILIATION_CRON",
      { reason: "scheduled_reconciliation" },
      { jobId: "reconciliation-cron", repeat: { every: repeatEveryMs } },
    );
  } finally {
    await releaseRedisLock({ connection, key: lock.key, token: lock.token }).catch(() => {});
  }
}
