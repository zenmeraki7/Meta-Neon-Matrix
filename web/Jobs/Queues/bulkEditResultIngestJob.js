import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildDefaultJobOptions,
  buildWebhookJobId,
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
  const entityId =
    data?.bulkOperationId || data?.admin_graphql_api_id || data?.id || "unknown";
  const jobId =
    options.jobId ||
    buildWebhookJobId({
      topic: "BULK_EDIT_RESULT_INGEST",
      webhookId: data?.webhookId,
      shop: data?.shop,
      entityId,
    });

  return bulkEditResultIngestQueue.add(
    "bulk-edit-result-ingest",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
