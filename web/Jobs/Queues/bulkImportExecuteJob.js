import { bulkImportExecuteQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 7,
  backoffDelay: 10_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

export async function addBulkImportExecuteJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.executionId) {
    throw new Error("bulk import execute job requires historyId, shop, and executionId");
  }

  return bulkImportExecuteQueue.add(
    "bulk-import-execute",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId:
        options.jobId
        || joinSafeJobId("bulk-import-execute", data.shop, data.historyId),
    }),
  );
}
