import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildBulkResultIngestJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME = process.env.BULK_EDIT_RESULT_INGEST_QUEUE || "bulk-edit-result-ingest";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 8,
  backoffDelay: 5_000,
  removeOnComplete: { age: 48 * 3600, count: 2_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
});

export const bulkEditResultIngestQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
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
