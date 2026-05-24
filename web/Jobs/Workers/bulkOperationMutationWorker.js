import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "../Queues/bulkUndoResultIngestJob.js";
import { prisma } from "../../config/database.js";
import { logWebhookError } from "../../utils/errorLogUtils.js";
import logger from "../../utils/loggerUtils.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";

const QUEUE_NAME =
  process.env.BULK_OPERATION_MUTATION_QUEUE || "bulk-operation-mutation";

async function hasUndoOwnerForBulkOperation(shop, bulkOperationId) {
  const byColumn = await prisma.editHistory.findFirst({
    where: { shop, bulkOperationId: String(bulkOperationId) },
    select: { id: true, undo: true },
  });
  if (byColumn?.undo && typeof byColumn.undo === "object") {
    const undoBulkOperationId = String(byColumn.undo.bulkOperationId || "");
    if (undoBulkOperationId === String(bulkOperationId)) return true;
  }
  const byUndo = await prisma.editHistory.findFirst({
    where: {
      shop,
      undo: {
        path: ["bulkOperationId"],
        equals: String(bulkOperationId),
      },
    },
    select: { id: true },
  });
  return Boolean(byUndo);
}

const bulkOperationMutationWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    const bulkOperationId = job.data?.admin_graphql_api_id;
    const status = String(job.data?.status || "").toUpperCase();
    const type = String(job.data?.type || "").toUpperCase();

    if (!shop || !bulkOperationId) {
      throw new Error("bulk-operation-mutation job requires shop and admin_graphql_api_id");
    }

    try {
      // Single path: all mutation webhook statuses are delegated to the
      // bulk edit result ingestion pipeline for deterministic lifecycle handling.
      if (type === "MUTATION") {
        const isUndoBulkOperation = await hasUndoOwnerForBulkOperation(
          shop,
          bulkOperationId,
        );

        if (isUndoBulkOperation) {
          await addbulkUndoResultIngestJob({
            shop,
            webhookId: job.data?.webhookId,
            bulkOperationId,
            admin_graphql_api_id: bulkOperationId,
            status,
            type,
            url: job.data?.url || null,
            partialDataUrl: job.data?.partialDataUrl || null,
            payload: job.data || null,
          });
          return {
            success: true,
            shop,
            bulkOperationId,
            enqueued: "bulk-undo-result-ingest",
            status,
          };
        }

        await addbulkEditResultIngestJob({
          shop,
          webhookId: job.data?.webhookId,
          bulkOperationId,
          admin_graphql_api_id: bulkOperationId,
          status,
          type,
          url: job.data?.url || null,
          partialDataUrl: job.data?.partialDataUrl || null,
          payload: job.data || null,
        });
        return {
          success: true,
          shop,
          bulkOperationId,
          enqueued: "bulk-edit-result-ingest",
          status,
        };
      }

      return {
        success: false,
        ignored: true,
        reason: "non_mutation_bulk_operation",
        shop,
        bulkOperationId,
      };
    } catch (error) {
      await logWebhookError({
        shop,
        req: job.data,
        source: "bulkOperationMutationWorker",
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

bulkOperationMutationWorker.on("failed", (job, error) => {
  logger.error("Bulk operation mutation worker failed", {
    worker: "bulkOperationMutationWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.admin_graphql_api_id,
    attempt: getJobAttempt(job),
    message: error.message,
  });
});

bulkOperationMutationWorker.on("completed", (job, result) => {
  logger.info("Bulk operation mutation worker completed", {
    worker: "bulkOperationMutationWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.admin_graphql_api_id,
    attempt: getJobAttempt(job),
    result,
  });
});

bulkOperationMutationWorker.on("failed", async (job) => {
  if (isRetryExhausted(job)) {
    await recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: "bulkOperationMutationWorker",
      queue: QUEUE_NAME,
      entityType: "bulkOperation",
      entityId: job?.data?.admin_graphql_api_id,
      executionId: job?.data?.admin_graphql_api_id,
      message: "Bulk operation mutation worker exhausted retries",
    });
  }
});

export default bulkOperationMutationWorker;
