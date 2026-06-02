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
  if (!data?.shop || !data?.bulkOperationId) {
    throw new Error("bulk edit result ingest job requires shop and bulkOperationId");
  }
  const entityId = data.bulkOperationId;
  const jobId =
    options.jobId
    || buildBulkResultIngestJobId({
      shop: data?.shop,
      bulkOperationId: entityId,
    });

  return bulkEditResultIngestQueue.add(
    "bulk-edit-result-ingest",
    {
      ...data,
      bulkOperationId: String(data.bulkOperationId),
    },
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
