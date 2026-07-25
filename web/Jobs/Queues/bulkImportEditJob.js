import { bulkImportEditQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildDefaultJobOptions,
  mergeJobOptions,
  joinSafeJobId,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 4,
  priority: 6,
  backoffDelay: 10_000,
  removeOnComplete: { age: 24 * 3600, count: 500 },
  removeOnFail: { age: 14 * 24 * 3600, count: 2_000 },
});

export async function addbulkImportEditJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.filePath) {
    throw new Error("bulk import edit job requires historyId, shop, and filePath");
  }

  const jobId = options.jobId || joinSafeJobId("import-edit", data?.historyId);

  return bulkImportEditQueue.add(
    "bulk-import-edit",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
