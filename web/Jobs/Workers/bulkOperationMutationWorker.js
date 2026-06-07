import { UnrecoverableError, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "../Queues/bulkUndoResultIngestJob.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";
import crypto from "crypto";
import { sha256Stable } from "../../utils/canonicalJson.js";
import { bulkOperationMutationDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { releaseShopifyBulkMutationSlot } from "../../services/shopifyBulkMutationSlotLease.js";
import { webhookProcessingLagMs } from "../../utils/metricsUtils.js";

const QUEUE_NAME =
  process.env.BULK_OPERATION_MUTATION_QUEUE || "bulk-operation-mutation";
const DLQ_NAME =
  process.env.BULK_OPERATION_MUTATION_DLQ_QUEUE || "bulk-operation-mutation-dlq";
const WORKER_NAME = "bulkOperationMutationWorker";

async function completeMutationFinishProcessing(shop, result) {
  await releaseShopifyBulkMutationSlot(shop);
  return result;
}

async function resolveOperationKindByLedger(shop, bulkOperationId) {
  const ledgerMatch = await db.bulkSubmission.findUnique({
    where: {
      shop_shopifyBulkOperationId: {
        shop,
        shopifyBulkOperationId: String(bulkOperationId),
      },
    },
    select: {
      id: true,
      editHistoryId: true,
    },
  });
  if (ledgerMatch?.id) {
    return {
      operationKind: "EDIT",
      source: "bulk_submission_ledger",
      editHistoryId: ledgerMatch.editHistoryId || null,
    };
  }

  return null;
}

async function hasUndoOwnerForBulkOperation(shop, bulkOperationId) {
  const owner = await db.editHistory.findFirst({
    where: {
      shop,
      OR: [
        { bulkOperationId: String(bulkOperationId) },
        {
          undo: {
            path: ["bulkOperationId"],
            equals: String(bulkOperationId),
          },
        },
      ],
    },
    select: { id: true, undo: true },
  });
  const undoBulkOperationId =
    owner?.undo && typeof owner.undo === "object"
      ? String(owner.undo.bulkOperationId || "")
      : "";
  return undoBulkOperationId === String(bulkOperationId);
}

function buildUnresolvedBulkWebhookDeliveryId({ shop, bulkOperationId }) {
  return `bulkop_unresolved_${crypto
    .createHash("sha1")
    .update(`${shop}:${bulkOperationId}`)
    .digest("hex")}`;
}

function buildCausalChainId({ shop, bulkOperationId }) {
  return `bulkop_chain_${crypto
    .createHash("sha1")
    .update(`${shop}:${bulkOperationId}:unresolved`)
    .digest("hex")}`;
}

async function persistUnresolvedBulkMutationDelivery({
  shop,
  bulkOperationId,
  payload,
}) {
  const id = buildUnresolvedBulkWebhookDeliveryId({ shop, bulkOperationId });
  const payloadHash = sha256Stable(payload || {});

  const data = {
    payloadHash,
    status: "QUEUED",
    lastError: "UNRESOLVED_BULK_OPERATION_OWNER",
    lastWebhookId: String(payload?.webhookId || "") || null,
    attemptCount: { increment: 1 },
  };
  const updated = await db.webhookDelivery.updateMany({
    where: { id, shop },
    data,
  });
  if (updated.count === 1) return;

  try {
    await db.webhookDelivery.create({
      data: {
      id,
      topic: "bulk_operations/finish_unresolved",
      shop,
      webhookId: String(payload?.webhookId || ""),
      firstWebhookId: String(payload?.webhookId || "") || null,
      lastWebhookId: String(payload?.webhookId || "") || null,
      causalChainId: buildCausalChainId({ shop, bulkOperationId }),
      entityId: String(bulkOperationId),
      dedupeKey: `bulkop-unresolved:${shop}:${bulkOperationId}`,
      payloadHash,
      status: "QUEUED",
      lastError: "UNRESOLVED_BULK_OPERATION_OWNER",
      },
    });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    const retried = await db.webhookDelivery.updateMany({
      where: { id, shop },
      data,
    });
    if (retried.count !== 1) {
      const collision = new Error("WEBHOOK_DELIVERY_CROSS_TENANT_ID_COLLISION");
      collision.nonRetryable = true;
      throw collision;
    }
  }
}

const bulkOperationMutationWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = String(job.data?.shop || "").trim();
    const bulkOperationId = String(job.data?.admin_graphql_api_id || "").trim();
    const status = String(job.data?.status || "").toUpperCase();
    const type = String(job.data?.type || "").toUpperCase();
    const deliveredAt = new Date(job.data?.createdAt || job.timestamp || Date.now()).getTime();
    webhookProcessingLagMs.observe({
      shop: shop || "unknown",
      topic: "bulk_operations/finish",
    }, Math.max(0, Date.now() - deliveredAt));

    if (!shop || !bulkOperationId) {
      throw new UnrecoverableError(
        "bulk-operation-mutation job requires shop and admin_graphql_api_id",
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

      // Single path: all mutation webhook statuses are delegated to the
      // bulk edit result ingestion pipeline for deterministic lifecycle handling.
      if (type === "MUTATION") {
        const ledgerResolution = await resolveOperationKindByLedger(
          shop,
          bulkOperationId,
        );

        if (ledgerResolution?.operationKind === "EDIT") {
          await addbulkEditResultIngestJob({
            shop,
            webhookId: job.data?.webhookId,
            bulkOperationId,
            status,
            type,
            url: job.data?.url || null,
            partialDataUrl: job.data?.partialDataUrl || null,
          });
          return completeMutationFinishProcessing(shop, {
            success: true,
            shop,
            bulkOperationId,
            enqueued: "bulk-edit-result-ingest",
            status,
            routedBy: ledgerResolution.source,
          });
        }

        const isUndoBulkOperation = await hasUndoOwnerForBulkOperation(
          shop,
          bulkOperationId,
        );

        if (isUndoBulkOperation) {
          await addbulkUndoResultIngestJob({
            shop,
            webhookId: job.data?.webhookId,
            bulkOperationId,
            status,
            type,
            url: job.data?.url || null,
            partialDataUrl: job.data?.partialDataUrl || null,
          });
          return completeMutationFinishProcessing(shop, {
            success: true,
            shop,
            bulkOperationId,
            enqueued: "bulk-undo-result-ingest",
            status,
          });
        }

        await persistUnresolvedBulkMutationDelivery({
          shop,
          bulkOperationId,
          payload: {
            webhookId: job.data?.webhookId || null,
            status,
            type,
            createdAt: job.data?.createdAt || null,
          },
        });
        return completeMutationFinishProcessing(shop, {
          success: true,
          skipped: true,
          shop,
          bulkOperationId,
          reason: "unresolved_bulk_operation_owner_persisted",
        });
      }

      return {
        success: true,
        skipped: true,
        reason: "non_mutation_type",
        shop,
        bulkOperationId,
        type,
      };
    } catch (error) {
      logger.error("Bulk operation mutation worker handler failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job?.id,
        shop,
        bulkOperationId,
        message: error?.message,
        stack: error?.stack,
      });
      if (error?.nonRetryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: Number(process.env.BULK_OPERATION_MUTATION_LOCK_DURATION_MS || 60_000),
    stalledInterval: Number(process.env.BULK_OPERATION_MUTATION_STALLED_INTERVAL_MS || 30_000),
    maxStalledCount: Number(process.env.BULK_OPERATION_MUTATION_MAX_STALLED_COUNT || 1),
  },
);

bulkOperationMutationWorker.on("failed", (job, error) => {
  logger.error("Bulk operation mutation worker failed", {
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
      message: error?.message || "Bulk operation mutation worker exhausted retries",
    }).catch((recordError) => {
      logger.error("Bulk operation mutation retry exhaustion recording failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: recordError?.message,
      });
    });
    void bulkOperationMutationDlqQueue.add(
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
      logger.error("Bulk operation mutation DLQ enqueue failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

bulkOperationMutationWorker.on("completed", (job, result) => {
  logger.info("Bulk operation mutation worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    bulkOperationId: job?.data?.admin_graphql_api_id,
    attempt: getJobAttempt(job),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
    enqueued: result?.enqueued || null,
  });
});

bulkOperationMutationWorker.on("stalled", (jobId) => {
  logger.warn("Bulk operation mutation worker stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkOperationMutationWorker.on("error", (error) => {
  logger.error("Bulk operation mutation worker runtime error", {
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
    await bulkOperationMutationWorker.close();
  } catch (error) {
    logger.error("Bulk operation mutation worker shutdown failed", {
      worker: WORKER_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkOperationMutationWorker;
