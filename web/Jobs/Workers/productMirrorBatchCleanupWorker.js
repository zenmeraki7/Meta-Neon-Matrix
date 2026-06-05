import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import {
  cleanupPreviousMirrorBatch,
} from "../../repositories/productSyncRepository.js";
import logger from "../../utils/loggerUtils.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";
import {
  PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE_NAME,
} from "../Queues/productMirrorBatchCleanupJob.js";

export const productMirrorBatchCleanupWorker = new Worker(
  PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE_NAME,
  async (job) => {
    const shop = String(job.data?.shop || "").trim();
    const mirrorBatchId = String(job.data?.mirrorBatchId || "").trim();
    if (!shop || !mirrorBatchId) {
      throw new Error("product mirror batch cleanup worker requires shop and mirrorBatchId");
    }

    const result = await cleanupPreviousMirrorBatch({
      shop,
      previousBatchId: mirrorBatchId,
    });
    return {
      shop,
      mirrorBatchId,
      ...result,
    };
  },
  {
    connection,
    concurrency: Number(process.env.PRODUCT_MIRROR_BATCH_CLEANUP_CONCURRENCY || 1),
  },
);

productMirrorBatchCleanupWorker.on("completed", (job, result) => {
  logger.info("Product mirror batch cleanup completed", {
    worker: "productMirrorBatchCleanupWorker",
    queue: PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    mirrorBatchId: job?.data?.mirrorBatchId,
    attempt: getJobAttempt(job),
    result,
  });
});

productMirrorBatchCleanupWorker.on("failed", async (job, error) => {
  logger.error("Product mirror batch cleanup failed", {
    worker: "productMirrorBatchCleanupWorker",
    queue: PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    mirrorBatchId: job?.data?.mirrorBatchId,
    attempt: getJobAttempt(job),
    message: error?.message || String(error),
  });

  if (isRetryExhausted(job)) {
    await recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: "productMirrorBatchCleanupWorker",
      queue: PRODUCT_MIRROR_BATCH_CLEANUP_QUEUE_NAME,
      entityType: "mirrorBatch",
      entityId: job?.data?.mirrorBatchId,
      executionId: job?.data?.mirrorBatchId,
      message: error?.message || "Product mirror batch cleanup exhausted retries",
    });
  }
});

export default productMirrorBatchCleanupWorker;
