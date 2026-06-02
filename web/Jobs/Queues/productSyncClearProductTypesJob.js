import { productSyncClearProductTypesQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  buildProductSyncClearTypesJobId,
  buildDefaultJobOptions,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 6,
  backoffDelay: 15_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

export async function addProductSyncClearProductTypesJob(data, options = {}) {
  if (!data?.shop || !data?.operationId) {
    throw new Error(
      "product sync clear product types job requires shop and operationId",
    );
  }

  return productSyncClearProductTypesQueue.add(
    "product-sync-clear-product-types",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId:
        options.jobId ||
        buildProductSyncClearTypesJobId({
          shop: data.shop,
          operationId: data.operationId,
        }),
    }),
  );
}
