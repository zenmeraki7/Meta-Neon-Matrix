import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { handleSyncOperation } from "../../helpers/webhookHelpers/bulkOperations/productTypeSync.js";
import { logWebhookError } from "../../utils/errorLogUtils.js";
import logger from "../../utils/loggerUtils.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";

const QUEUE_NAME =
  process.env.BULK_OPERATION_QUERY_QUEUE || "bulk-operation-query";

export const bulkOperationQueryWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    const shopifyBulkOperationId = job.data?.admin_graphql_api_id;

    if (!shop || !shopifyBulkOperationId) {
      throw new Error("bulk-operation-query job requires shop and admin_graphql_api_id");
    }

    try {
      await handleSyncOperation({
        shopifyBulkOperationId,
        shop,
      });
      return {
        success: true,
        shop,
        shopifyBulkOperationId,
      };
    } catch (error) {
      await logWebhookError({
        shop,
        req: job.data,
        source: "bulkOperationQueryWorker",
        err: error,
      });
      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
  },
);

bulkOperationQueryWorker.on("failed", (job, error) => {
  logger.error("Bulk operation query worker failed", {
    worker: "bulkOperationQueryWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    shopifyBulkOperationId: job?.data?.admin_graphql_api_id,
    attempt: getJobAttempt(job),
    message: error.message,
  });
});

bulkOperationQueryWorker.on("completed", (job, result) => {
  logger.info("Bulk operation query worker completed", {
    worker: "bulkOperationQueryWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    shopifyBulkOperationId: job?.data?.admin_graphql_api_id,
    attempt: getJobAttempt(job),
    result,
  });
});

bulkOperationQueryWorker.on("failed", async (job) => {
  if (isRetryExhausted(job)) {
    await recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: "bulkOperationQueryWorker",
      queue: QUEUE_NAME,
      entityType: "bulkOperation",
      entityId: job?.data?.admin_graphql_api_id,
      executionId: job?.data?.admin_graphql_api_id,
      message: "Bulk operation query worker exhausted retries",
    });
  }
});
