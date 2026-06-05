import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "../Queues/bulkUndoResultIngestJob.js";
import { db } from "../../repositories/repositoryDb.js";
import { logWebhookError } from "../../utils/errorLogUtils.js";
import logger from "../../utils/loggerUtils.js";
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";
import crypto from "crypto";

const QUEUE_NAME =
  process.env.BULK_OPERATION_MUTATION_QUEUE || "bulk-operation-mutation";

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
  const byColumn = await db.editHistory.findFirst({
    where: { shop, bulkOperationId: String(bulkOperationId) },
    select: { id: true, undo: true },
  });
  if (byColumn?.undo && typeof byColumn.undo === "object") {
    const undoBulkOperationId = String(byColumn.undo.bulkOperationId || "");
    if (undoBulkOperationId === String(bulkOperationId)) return true;
  }
  const byUndo = await db.editHistory.findFirst({
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
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload || {}))
    .digest("hex");

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
      throw new Error("WEBHOOK_DELIVERY_CROSS_TENANT_ID_COLLISION");
    }
  }
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
            payload: job.data || null,
          });
          return {
            success: true,
            shop,
            bulkOperationId,
            enqueued: "bulk-edit-result-ingest",
            status,
            routedBy: ledgerResolution.source,
          };
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

        await persistUnresolvedBulkMutationDelivery({
          shop,
          bulkOperationId,
          payload: job.data || {},
        });
        return {
          success: false,
          ignored: true,
          shop,
          bulkOperationId,
          reason: "unresolved_bulk_operation_owner_persisted",
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
