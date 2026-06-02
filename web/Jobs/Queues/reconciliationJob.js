import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import { buildDefaultJobOptions } from "../../utils/jobQueueUtils.js";

export const RECONCILIATION_QUEUE_NAME =
  process.env.RECONCILIATION_QUEUE_NAME || "reconciliation-scheduler";

const reconciliationQueue = new Queue(RECONCILIATION_QUEUE_NAME, {
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
  const repeatEveryMs = Number(process.env.RECONCILIATION_REPEAT_MS || 60 * 60 * 1000);
  return reconciliationQueue.add(
    "RECONCILIATION_CRON",
    { reason: "scheduled_reconciliation" },
    {
      jobId: "reconciliation-cron",
      repeat: { every: repeatEveryMs },
    },
  );
}

export { reconciliationQueue };
