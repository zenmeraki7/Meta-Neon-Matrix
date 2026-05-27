import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";

export const productSyncQueue = new Queue("product-sync-queue", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
    removeOnComplete: {
      age: 7 * 24 * 3600,
      count: 5000,
    },
    removeOnFail: {
      age: 30 * 24 * 3600,
      count: 20000,
    },
  },
});

export const setupProductSyncCron = async () => {
  if (process.env.NODE_ENV === "production") {
    return { skipped: true, reason: "retired_legacy_repeatable_setup" };
  }

  await productSyncQueue.add(
    "auto-sync-scheduler",
    { type: "auto-sync" },
    {
      repeat: {
        pattern: "0 */6 * * *",
      },
      jobId: "auto-sync-scheduler",
    },
  );

  return { scheduled: true };
};

