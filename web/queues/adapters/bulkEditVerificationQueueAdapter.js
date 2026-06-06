import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";

const VERIFY_QUEUE_NAME = process.env.BULK_EDIT_VERIFICATION_QUEUE || "bulk-edit-verification";

export const verificationQueue = new Queue(VERIFY_QUEUE_NAME, {
  connection,
  defaultJobOptions: {
    attempts: 6,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 10000 },
  },
});

export async function enqueueBulkEditVerification(
  { historyId, shop, executionId, source },
  options = {},
) {
  const derivedExecutionId = executionId || "default";
  return verificationQueue.add(
    "bulk-edit-verification",
    { historyId, shop, executionId, source },
    {
      jobId:
        options.jobId
        || `bulk-edit-verify:${shop}:${historyId}:${derivedExecutionId}`,
      ...options,
    },
  );
}
