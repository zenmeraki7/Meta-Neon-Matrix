import { bulkEditExecuteQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildBulkEditExecuteJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 7,
  backoffDelay: 30_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

const BULK_EDIT_EXECUTE_QUEUE = process.env.BULK_EDIT_EXECUTE_QUEUE || "bulk-edit-execute";

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
        options.jobId
        || buildBulkEditExecuteJobId({
          shop: data.shop,
          operationId: data.historyId,
          executionId: data.executionId,
        }),
    }),
  );
}
