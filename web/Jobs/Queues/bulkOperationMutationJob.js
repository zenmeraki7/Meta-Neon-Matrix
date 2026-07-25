import { bulkOperationMutationQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  bulkOperationMutationJobId,
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

export async function addbulkOperatonMutationJob(data, options = {}) {
  const shopifyBulkOperationId = data?.admin_graphql_api_id || data?.shopifyBulkOperationId || data?.id;
  if (!data?.shop || !shopifyBulkOperationId) {
    throw new Error("bulk operation mutation job requires shop and shopifyBulkOperationId");
  }
  const operationId = data?.operationId || shopifyBulkOperationId;
  const jobId =
    options.jobId
    || bulkOperationMutationJobId({
      shop: data?.shop,
      operationId,
      shopifyBulkOperationId,
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
