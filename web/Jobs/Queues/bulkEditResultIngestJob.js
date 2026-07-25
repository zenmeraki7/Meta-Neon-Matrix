import { bulkEditResultIngestQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildBulkResultIngestJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 8,
  backoffDelay: 5_000,
  removeOnComplete: { age: 48 * 3600, count: 2_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
});

export async function addbulkEditResultIngestJob(data, options = {}) {
  if (!data?.shop || !data?.shopifyBulkOperationId) {
    throw new Error("bulk edit result ingest job requires shop and shopifyBulkOperationId");
  }
  const entityId = data.shopifyBulkOperationId;
  const jobId =
    options.jobId
    || buildBulkResultIngestJobId({
      shop: data?.shop,
      shopifyBulkOperationId: entityId,
    });

  return bulkEditResultIngestQueue.add(
    "bulk-edit-result-ingest",
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
