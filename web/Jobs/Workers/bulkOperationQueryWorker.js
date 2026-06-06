import { UnrecoverableError, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { handleSyncOperation } from "../../helpers/webhookHelpers/bulkOperations/productTypeSync.js";
import logger from "../../utils/loggerUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getBulkEditStatus } from "../../utils/bulkOperationHelper.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";
import { addbulkOperatonQueryJob } from "../Queues/bulkOperationQueryJob.js";
import { bulkOperationQueryDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const QUEUE_NAME =
  process.env.BULK_OPERATION_QUERY_QUEUE || "bulk-operation-query";
const DLQ_NAME =
  process.env.BULK_OPERATION_QUERY_DLQ_QUEUE || "bulk-operation-query-dlq";
const WORKER_NAME = "bulkOperationQueryWorker";
const TERMINAL_SYNC_STATUSES = new Set(["completed", "failed"]);
const QUERY_SYNC_OPERATION_TYPES = ["Product", "Collection", "ProductType"];

export const bulkOperationQueryWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = String(job.data?.shop || "").trim();
    const bulkOperationId = String(job.data?.admin_graphql_api_id || "").trim();

    if (!shop || !bulkOperationId) {
      throw new UnrecoverableError(
        "bulk-operation-query job requires shop and admin_graphql_api_id",
      );
    }

    try {
      const store = await db.store.findUnique({
        where: { shopUrl: shop },
        select: { isUnInstalled: true },
      });
      if (!store || store.isUnInstalled) {
        return {
          success: true,
          skipped: true,
          reason: "shop_not_installed",
          shop,
          bulkOperationId,
        };
      }

      const syncRecord = await db.syncHistory.findFirst({
        where: {
          shop,
          bulkOperationId,
          operationType: { in: QUERY_SYNC_OPERATION_TYPES },
        },
        select: {
          id: true,
          status: true,
          stage: true,
        },
      });
      if (!syncRecord) {
        throw new UnrecoverableError("SYNC_RECORD_NOT_FOUND_FOR_BULK_OPERATION");
      }
      if (TERMINAL_SYNC_STATUSES.has(String(syncRecord.status || "").toLowerCase())) {
        return {
          success: true,
          skipped: true,
          reason: `already_terminal:${syncRecord.status}`,
          shop,
          bulkOperationId,
          syncHistoryId: syncRecord.id,
        };
      }

      const result = await handleSyncOperation({
        bulkOperationId,
        shop,
      });
      return {
        success: true,
        skipped: Boolean(result?.skipped),
        reason: result?.reason || null,
        shop,
        bulkOperationId,
        result,
      };
    } catch (error) {
      logger.error("Bulk operation query worker handler failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job?.id,
        shop,
        bulkOperationId,
        message: error?.message,
        stack: error?.stack,
      });
      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: Number(process.env.BULK_OPERATION_QUERY_LOCK_DURATION_MS || 600_000),
    stalledInterval: Number(process.env.BULK_OPERATION_QUERY_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.BULK_OPERATION_QUERY_MAX_STALLED_COUNT || 1),
  },
);

bulkOperationQueryWorker.on("failed", (job, error) => {
  logger.error("Bulk operation query worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.admin_graphql_api_id,
    attempt: getJobAttempt(job),
    message: error?.message,
    stack: error?.stack,
  });
  if (isRetryExhausted(job) || error?.name === "UnrecoverableError") {
    void recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      entityType: "bulkOperation",
      entityId: job?.data?.admin_graphql_api_id,
      executionId: job?.data?.admin_graphql_api_id,
      message: error?.message || "Bulk operation query worker exhausted retries",
    }).catch((recordError) => {
      logger.error("Bulk operation query retry exhaustion recording failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: recordError?.message,
      });
    });
    void bulkOperationQueryDlqQueue.add(
      DLQ_NAME,
      {
        originalJobId: job?.id,
        data: job?.data,
        failedReason: error?.message,
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      { jobId: `dlq:${QUEUE_NAME}:${job?.id}` },
    ).catch((dlqError) => {
      logger.error("Bulk operation query DLQ enqueue failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

bulkOperationQueryWorker.on("completed", (job, result) => {
  logger.info("Bulk operation query worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.admin_graphql_api_id,
    attempt: getJobAttempt(job),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

bulkOperationQueryWorker.on("stalled", (jobId) => {
  logger.warn("Bulk operation query worker stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkOperationQueryWorker.on("error", (error) => {
  logger.error("Bulk operation query worker runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: error?.message,
    stack: error?.stack,
  });
});

export async function recoverCompletedProductBulkOperations({ shop }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("bulk query boot recovery requires shop");
  }
  const stuckSyncs = await db.syncHistory.findMany({
    where: {
      shop: scopedShop,
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

      logger.info("Bulk query boot recovery enqueueing completed product bulk operation", {
        worker: "bulkOperationQueryWorker",
        shop: sync.shop,
        syncHistoryId: sync.id,
        bulkOperationId: sync.bulkOperationId,
      });

      await addbulkOperatonQueryJob(
        {
          admin_graphql_api_id: sync.bulkOperationId,
          shop: sync.shop,
          source: "bulk_query_boot_recovery",
        },
        { jobId: `recovery:${sync.shop}:${sync.bulkOperationId}` },
      );
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

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await bulkOperationQueryWorker.close();
  } catch (error) {
    logger.error("Bulk operation query worker shutdown failed", {
      worker: WORKER_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
