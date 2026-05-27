import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  bulkOperationMutationJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME =
  process.env.BULK_OPERATION_MUTATION_QUEUE || "bulk-operation-mutation";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 8,
  priority: 8,
  backoffDelay: 5_000,
  removeOnComplete: { age: 48 * 3600, count: 2_000 },
  removeOnFail: { age: 14 * 24 * 3600, count: 10_000 },
});

export const bulkOperationMutationQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addbulkOperatonMutationJob(data, options = {}) {
  const bulkOperationId = data?.admin_graphql_api_id || data?.bulkOperationId || data?.id;
  if (!data?.shop || !bulkOperationId) {
    throw new Error("bulk operation mutation job requires shop and bulkOperationId");
  }
  const operationId = data?.operationId || bulkOperationId;
  const jobId =
    options.jobId
    || bulkOperationMutationJobId({
      shop: data?.shop,
      operationId,
      bulkOperationId,
    });

  return bulkOperationMutationQueue.add(
    "bulk-operation-mutation",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId,
    }),
  );
}
