import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = process.env.BULK_EDIT_EXECUTE_QUEUE || "bulk-edit-execute";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 7,
  backoffDelay: 30_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

export const bulkEditExecuteQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addBulkEditExecuteJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.executionId) {
    throw new Error(
      "bulk edit execute job requires historyId, shop, and executionId",
    );
  }

  return bulkEditExecuteQueue.add(
    "bulk-edit-execute",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId:
        options.jobId ||
        joinSafeJobId(
          "bulk-edit-execute",
          data.historyId,
          data.executionId,
          data.source || "default",
        ),
    }),
  );
}
