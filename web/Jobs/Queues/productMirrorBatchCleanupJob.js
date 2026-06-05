import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  buildDefaultJobOptions,
  joinSafeJobId,
  mergeJobOptions,
} from "../../utils/jobQueueUtils.js";

export const PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE_NAME =
  process.env.PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE || "product-mirror-batch-cleanup";

export const productMirrorBatchCleanupQueue = new Queue(
  PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE_NAME,
  {
    connection,
    defaultJobOptions: buildDefaultJobOptions({
      attempts: 10,
      priority: 8,
      backoffDelay: 10_000,
      removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 10_000 },
    }),
  },
);

export function buildProductMirrorBatchCleanupJobId({ shop, mirrorBatchId }) {
  return joinSafeJobId("product-mirror-batch-cleanup", shop, mirrorBatchId);
}

export async function addProductMirrorBatchCleanupJob(data, options = {}) {
  const shop = String(data?.shop || "").trim();
  const mirrorBatchId = String(data?.mirrorBatchId || "").trim();
  if (!shop || !mirrorBatchId) {
    throw new Error("product mirror batch cleanup job requires shop and mirrorBatchId");
  }

  return productMirrorBatchCleanupQueue.add(
    "cleanup-product-mirror-batch",
    {
      shop,
      mirrorBatchId,
      source: data?.source || "product_sync_activation",
    },
    mergeJobOptions(
      {
        jobId: buildProductMirrorBatchCleanupJobId({ shop, mirrorBatchId }),
      },
      options,
    ),
  );
}
