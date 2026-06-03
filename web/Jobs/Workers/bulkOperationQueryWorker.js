import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { handleSyncOperation } from "../../helpers/webhookHelpers/bulkOperations/productTypeSync.js";
import { logWebhookError } from "../../utils/errorLogUtils.js";
import logger from "../../utils/loggerUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getBulkEditStatus } from "../../utils/bulkOperationHelper.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";

const QUEUE_NAME =
  process.env.BULK_OPERATION_QUERY_QUEUE || "bulk-operation-query";

export const bulkOperationQueryWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    const bulkOperationId = job.data?.admin_graphql_api_id;

    if (!shop || !bulkOperationId) {
      throw new Error("bulk-operation-query job requires shop and admin_graphql_api_id");
    }

    try {
      await handleSyncOperation({
        bulkOperationId,
        shop,
      });
      return {
        success: true,
        shop,
        bulkOperationId,
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
    bulkOperationId: job?.data?.admin_graphql_api_id,
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
    bulkOperationId: job?.data?.admin_graphql_api_id,
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

async function recoverCompletedProductBulkOperations() {
  const stuckSyncs = await db.syncHistory.findMany({
    where: {
      operationType: "Product",
      status: "processing",
      stage: "SHOPIFY_BULK_RUNNING",
      bulkOperationId: { not: null },
    },
    orderBy: { createdAt: "asc" },
    take: Number(process.env.BULK_QUERY_BOOT_RECOVERY_LIMIT || 10),
    select: {
      id: true,
      shop: true,
      bulkOperationId: true,
      createdAt: true,
    },
  });

  for (const sync of stuckSyncs) {
    try {
      const session = await getSession(sync.shop);
      if (!session) {
        logger.warn("Bulk query boot recovery skipped; session missing", {
          worker: "bulkOperationQueryWorker",
          shop: sync.shop,
          syncHistoryId: sync.id,
        });
        continue;
      }

      const status = await getBulkEditStatus(sync.bulkOperationId, session);
      if (String(status?.status || "").toUpperCase() !== "COMPLETED") {
        logger.info("Bulk query boot recovery skipped; Shopify bulk not completed", {
          worker: "bulkOperationQueryWorker",
          shop: sync.shop,
          syncHistoryId: sync.id,
          bulkOperationId: sync.bulkOperationId,
          status: status?.status || null,
        });
        continue;
      }

      logger.info("Bulk query boot recovery ingesting completed product bulk operation", {
        worker: "bulkOperationQueryWorker",
        shop: sync.shop,
        syncHistoryId: sync.id,
        bulkOperationId: sync.bulkOperationId,
      });

      await handleSyncOperation({
        bulkOperationId: sync.bulkOperationId,
        shop: sync.shop,
      });
    } catch (error) {
      logger.error("Bulk query boot recovery failed", {
        worker: "bulkOperationQueryWorker",
        shop: sync.shop,
        syncHistoryId: sync.id,
        bulkOperationId: sync.bulkOperationId,
        message: error.message,
        stack: error.stack,
      });
    }
  }
}

void recoverCompletedProductBulkOperations().catch((error) => {
  logger.error("Bulk query boot recovery crashed non-fatally", {
    worker: "bulkOperationQueryWorker",
    message: error.message,
    stack: error.stack,
  });
});
