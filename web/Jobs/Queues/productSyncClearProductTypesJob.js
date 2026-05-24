import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

const QUEUE_NAME =
  process.env.PRODUCT_SYNC_CLEAR_PRODUCT_TYPES_QUEUE || "product-sync-clear-product-types";

const defaultJobOptions = buildDefaultJobOptions({
  attempts: 6,
  priority: 6,
  backoffDelay: 15_000,
  removeOnComplete: { age: 7 * 24 * 3600, count: 2_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
});

export const productSyncClearProductTypesQueue = new Queue(QUEUE_NAME, {
  connection,
  defaultJobOptions,
});

export async function addProductSyncClearProductTypesJob(data, options = {}) {
  if (!data?.shop || !data?.operationId || !data?.executionId) {
    throw new Error(
      "product sync clear product types job requires shop, operationId, and executionId",
    );
  }

  return productSyncClearProductTypesQueue.add(
    "product-sync-clear-product-types",
    data,
    mergeJobOptions(defaultJobOptions, {
      ...options,
      jobId:
        options.jobId ||
        joinSafeJobId(
          "product-sync-clear-product-types",
          data.shop,
          data.operationId,
          data.executionId,
        ),
    }),
  );
}
