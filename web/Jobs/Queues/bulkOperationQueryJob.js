import { bulkOperationQueryQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
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

export async function addbulkOperatonQueryJob(data, options = {}) {
  const entityId =
    data?.admin_graphql_api_id || data?.id || data?.bulkOperationId || "unknown";

  const jobId =
    options.jobId ||
    `bulk-op-query-finish:${data?.shop}:${entityId}`;

  return bulkOperationQueryQueue.add(
    "bulk-operation-query",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
