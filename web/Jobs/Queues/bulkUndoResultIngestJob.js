import { bulkUndoResultIngestQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  joinSafeJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 8,
  backoffDelay: 10_000,
  removeOnComplete: { age: 48 * 3600, count: 2_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
});

export async function addbulkUndoResultIngestJob(data, options = {}) {
  if (!data?.shop || !data?.shopifyBulkOperationId) {
    throw new Error("bulk undo result ingest job requires shop and shopifyBulkOperationId");
  }
  const entityId = data.shopifyBulkOperationId;
  const jobId =
    options.jobId
    || joinSafeJobId("undo-result-ingest", data?.shop, entityId);

  return bulkUndoResultIngestQueue.add(
    "bulk-undo-result-ingest",
    {
      ...data,
      shopifyBulkOperationId: String(data.shopifyBulkOperationId),
    },
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
