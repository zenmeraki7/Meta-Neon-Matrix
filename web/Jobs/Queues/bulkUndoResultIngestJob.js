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

const VALID_BULK_STATUSES = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "EXPIRED",
  "CANCELED",
  "CANCELLED",
  "CANCELLATION_FAILED",
]);

export async function addbulkUndoResultIngestJob(data, options = {}) {
  if (!data?.shop || !data?.bulkOperationId) {
    throw new Error("bulk undo result ingest job requires shop and bulkOperationId");
  }
  const entityId = data.bulkOperationId;
  const rawStatus = String(data?.status || "").trim().toUpperCase();
  const status = rawStatus && VALID_BULK_STATUSES.has(rawStatus) ? rawStatus : null;
  const jobId =
    options.jobId
    || joinSafeJobId("undo-result-ingest", data?.shop, entityId);

  return bulkUndoResultIngestQueue.add(
    "bulk-undo-result-ingest",
    {
      ...data,
      bulkOperationId: String(data.bulkOperationId),
      status,
    },
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
