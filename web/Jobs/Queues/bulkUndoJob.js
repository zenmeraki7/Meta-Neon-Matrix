import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildDefaultJobOptions,
  mergeJobOptions,
  joinSafeJobId,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = process.env.UNDO_QUEUE || "bulk-undo";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 7,
  backoffDelay: 10_000,
  removeOnComplete: { age: 48 * 3600, count: 1_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
});

export const bulkUndoQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addbulkUndoJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.executionId) {
    throw new Error("bulk undo job requires historyId, shop, and executionId");
  }

  const jobId =
    options.jobId
    || joinSafeJobId(
      "bulk-undo",
      data?.historyId,
      data?.executionId,
      data?.source || "default",
    );

  return bulkUndoQueue.add(
    "bulk-undo",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
