import { bulkUndoQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildUndoExecuteJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 7,
  backoffDelay: 10_000,
  removeOnComplete: { age: 48 * 3600, count: 1_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 5_000 },
});

export async function addbulkUndoJob(data, options = {}) {
  if (!data?.historyId || !data?.shop || !data?.executionId) {
    throw new Error("bulk undo job requires historyId, shop, and executionId");
  }
  if (
    Object.prototype.hasOwnProperty.call(data, "filterParams")
    || Object.prototype.hasOwnProperty.call(data, "filterAst")
    || Object.prototype.hasOwnProperty.call(data, "queryFilter")
  ) {
    throw new Error("RAW_TARGETING_PAYLOAD_FORBIDDEN");
  }

  const jobId =
    options.jobId
    || buildUndoExecuteJobId({
      shop: data.shop,
      undoOperationId: data.historyId,
    });

  return bulkUndoQueue.add(
    "bulk-undo",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
