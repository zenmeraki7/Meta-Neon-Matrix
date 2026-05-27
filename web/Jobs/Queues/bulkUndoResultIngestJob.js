import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  joinSafeJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME =
  process.env.BULK_UNDO_RESULT_INGEST_QUEUE || "bulk-undo-result-ingest";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 8,
  backoffDelay: 10_000,
  removeOnComplete: { age: 48 * 3600, count: 2_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
});

export const bulkUndoResultIngestQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addbulkUndoResultIngestJob(data, options = {}) {
  if (!data?.shop || !data?.bulkOperationId) {
    throw new Error("bulk undo result ingest job requires shop and bulkOperationId");
  }
  const entityId = data.bulkOperationId;
  const jobId =
    options.jobId
    || joinSafeJobId("undo-result-ingest", data?.shop, entityId);

  return bulkUndoResultIngestQueue.add(
    "bulk-undo-result-ingest",
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
