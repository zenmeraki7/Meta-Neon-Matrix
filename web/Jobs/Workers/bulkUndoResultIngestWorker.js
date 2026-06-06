import { UnrecoverableError, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { UndoResultIngestionService } from "../../services/undo/UndoResultIngestionService.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { bulkUndoResultIngestDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { isRetryExhausted } from "../../utils/workerTelemetry.js";
import { getSession } from "../../utils/sessionHandler.js";
import shopify from "../../shopify.js";

const QUEUE_NAME =
  process.env.BULK_UNDO_RESULT_INGEST_QUEUE || "bulk-undo-result-ingest";
const DLQ_NAME =
  process.env.BULK_UNDO_RESULT_INGEST_DLQ_QUEUE || "bulk-undo-result-ingest-dlq";
const WORKER_NAME = "bulkUndoResultIngestWorker";
const VALID_BULK_STATUSES = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "EXPIRED",
  "CANCELED",
  "CANCELLED",
  "CANCELLATION_FAILED",
]);
const BULK_OPERATION_STATUS_QUERY = `#graphql
  query BulkUndoOperationStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        type
      }
    }
  }
`;

function normalizeBulkStatus(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized && VALID_BULK_STATUSES.has(normalized) ? normalized : null;
}

async function fetchAuthoritativeBulkStatus({ shop, bulkOperationId }) {
  const session = await getSession(shop);
  if (!session?.shop || session.shop !== shop || !session?.accessToken) {
    throw new UnrecoverableError("SHOP_SESSION_NOT_AVAILABLE");
  }
  const client = new shopify.api.clients.Graphql({ session });
  const response = await client.query({
    data: {
      query: BULK_OPERATION_STATUS_QUERY,
      variables: { id: bulkOperationId },
    },
  });
  const node = response?.body?.data?.node || null;
  if (!node?.id) {
    throw new UnrecoverableError("UNDO_BULK_OPERATION_NOT_FOUND_IN_SHOPIFY");
  }
  const status = normalizeBulkStatus(node.status);
  if (!status) {
    throw new Error(`UNDO_BULK_OPERATION_STATUS_UNEXPECTED:${node.status || "UNKNOWN"}`);
  }
  return status;
}

async function processBulkUndoResultIngest(job) {
  const shop = String(job.data?.shop || "").trim();
  const bulkOperationId = String(job.data?.bulkOperationId || "").trim();
  const rawStatus = String(job.data?.status || "").trim().toUpperCase();
  const status = normalizeBulkStatus(rawStatus);
  if (!shop || !bulkOperationId) {
    throw new UnrecoverableError(
      "bulk undo result ingest job requires shop and bulkOperationId",
    );
  }
  if (rawStatus && !status) {
    logger.warn("Unexpected bulk operation status in undo result ingest payload", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      jobId: job?.id,
      shop,
      bulkOperationId,
      rawStatus,
    });
  }

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

  const ownedUndo = await db.editHistory.findFirst({
    where: {
      shop,
      OR: [
        { bulkOperationId },
        { undo: { path: ["bulkOperationId"], equals: bulkOperationId } },
      ],
    },
    select: { id: true },
  });
  if (!ownedUndo) {
    logger.warn("Bulk undo result ingest has no matching shop-owned undo", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      jobId: job?.id,
      shop,
      bulkOperationId,
    });
    return {
      success: true,
      skipped: true,
      reason: "undo_operation_not_found",
      shop,
      bulkOperationId,
    };
  }

  const authoritativeStatus = await fetchAuthoritativeBulkStatus({
    shop,
    bulkOperationId,
  });
  const service = new UndoResultIngestionService();
  const result = await service.ingestUndoBulkOperationWebhook({
    shop,
    bulkOperationId,
    status: authoritativeStatus,
  });

  return {
    success: true,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
    shop,
    bulkOperationId,
    authoritativeStatus,
    result,
  };
}

const bulkUndoResultIngestWorker = new Worker(
  QUEUE_NAME,
  processBulkUndoResultIngest,
  {
    connection,
    concurrency: 1,
    lockDuration: Number(process.env.BULK_UNDO_RESULT_INGEST_LOCK_DURATION_MS || 600_000),
    stalledInterval: Number(process.env.BULK_UNDO_RESULT_INGEST_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.BULK_UNDO_RESULT_INGEST_MAX_STALLED_COUNT || 1),
  },
);

bulkUndoResultIngestWorker.on("completed", (job, result) => {
  logger.info("Bulk undo result ingest worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.bulkOperationId,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

bulkUndoResultIngestWorker.on("failed", (job, error) => {
  logger.error("Bulk undo result ingest worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.bulkOperationId,
    attemptsMade: job?.attemptsMade,
    message: error?.message,
    stack: error?.stack,
  });
  if (isRetryExhausted(job) || error?.name === "UnrecoverableError") {
    void bulkUndoResultIngestDlqQueue.add(
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
      logger.error("Bulk undo result ingest DLQ enqueue failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

bulkUndoResultIngestWorker.on("stalled", (jobId) => {
  logger.warn("Bulk undo result ingest worker stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkUndoResultIngestWorker.on("error", (error) => {
  logger.error("Bulk undo result ingest worker runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: error?.message,
    stack: error?.stack,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await bulkUndoResultIngestWorker.close();
  } catch (error) {
    logger.error("Bulk undo result ingest worker shutdown failed", {
      worker: WORKER_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkUndoResultIngestWorker;
