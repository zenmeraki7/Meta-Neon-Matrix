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

async function resolveOperationKindByLedger(shop, shopifyBulkOperationId) {
  const ledgerMatch = await db.bulkSubmission.findUnique({
    where: {
      shop_shopifyBulkOperationId: {
        shop,
        shopifyBulkOperationId: String(shopifyBulkOperationId),
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

async function hasUndoOwnerForBulkOperation(shop, shopifyBulkOperationId) {
  const byColumn = await db.editHistory.findFirst({
    where: { shop, shopifyBulkOperationId: String(shopifyBulkOperationId) },
    select: { id: true, undo: true },
  });
  if (byColumn?.undo && typeof byColumn.undo === "object") {
    const undoBulkOperationId = String(byColumn.undo.shopifyBulkOperationId || "");
    if (undoBulkOperationId === String(shopifyBulkOperationId)) return true;
  }
  const byUndo = await db.editHistory.findFirst({
    where: {
      shop,
      undo: {
        path: ["shopifyBulkOperationId"],
        equals: String(shopifyBulkOperationId),
      },
    },
    select: { id: true },
  });
  return Boolean(byUndo);
}

function buildUnresolvedBulkWebhookDeliveryId({ shop, shopifyBulkOperationId }) {
  return `bulkop_unresolved_${crypto
    .createHash("sha1")
    .update(`${shop}:${shopifyBulkOperationId}`)
    .digest("hex")}`;
}

function buildCausalChainId({ shop, shopifyBulkOperationId }) {
  return `bulkop_chain_${crypto
    .createHash("sha1")
    .update(`${shop}:${shopifyBulkOperationId}:unresolved`)
    .digest("hex")}`;
}

async function persistUnresolvedBulkMutationDelivery({
  shop,
  shopifyBulkOperationId,
  payload,
}) {
  const id = buildUnresolvedBulkWebhookDeliveryId({ shop, shopifyBulkOperationId });
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload || {}))
    .digest("hex");

  await db.webhookDelivery.upsert({
    where: { id },
    create: {
      id,
      topic: "bulk_operations/finish_unresolved",
      shop,
      shopifyWebhookId: String(payload?.webhookId || "") || null,
      firstWebhookId: String(payload?.webhookId || "") || null,
      lastWebhookId: String(payload?.webhookId || "") || null,
      causalChainId: buildCausalChainId({ shop, shopifyBulkOperationId }),
      entityId: String(shopifyBulkOperationId),
      dedupeKey: `bulkop-unresolved:${shop}:${shopifyBulkOperationId}`,
      payloadHash,
      status: "QUEUED",
      lastError: "UNRESOLVED_BULK_OPERATION_OWNER",
    },
    update: {
      payloadHash,
      status: "QUEUED",
      lastError: "UNRESOLVED_BULK_OPERATION_OWNER",
      lastWebhookId: String(payload?.webhookId || "") || null,
      attemptCount: { increment: 1 },
    },
  });
}

const bulkOperationMutationWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const shop = job.data?.shop;
    const shopifyBulkOperationId = job.data?.admin_graphql_api_id;
    const status = String(job.data?.status || "").toUpperCase();
    const type = String(job.data?.type || "").toUpperCase();

    if (!shop || !shopifyBulkOperationId) {
      throw new Error("bulk-operation-mutation job requires shop and admin_graphql_api_id");
    }

    try {
      // Single path: all mutation webhook statuses are delegated to the
      // bulk edit result ingestion pipeline for deterministic lifecycle handling.
      if (type === "MUTATION") {
        const ledgerResolution = await resolveOperationKindByLedger(
          shop,
          shopifyBulkOperationId,
        );

        if (ledgerResolution?.operationKind === "EDIT") {
          await addbulkEditResultIngestJob({
            shop,
            webhookId: job.data?.webhookId,
            shopifyBulkOperationId,
            status,
            type,
            url: job.data?.url || null,
            partialDataUrl: job.data?.partialDataUrl || null,
            payload: job.data || null,
          });
          return {
            success: true,
            shop,
            shopifyBulkOperationId,
            enqueued: "bulk-edit-result-ingest",
            status,
            routedBy: ledgerResolution.source,
          };
        }

        const isUndoBulkOperation = await hasUndoOwnerForBulkOperation(
          shop,
          shopifyBulkOperationId,
        );

        if (isUndoBulkOperation) {
          await addbulkUndoResultIngestJob({
            shop,
            webhookId: job.data?.webhookId,
            shopifyBulkOperationId,
            status,
            type,
            url: job.data?.url || null,
            partialDataUrl: job.data?.partialDataUrl || null,
            payload: job.data || null,
          });
          return {
            success: true,
            shop,
            shopifyBulkOperationId,
            enqueued: "bulk-undo-result-ingest",
            status,
          };
        }

        await persistUnresolvedBulkMutationDelivery({
          shop,
          shopifyBulkOperationId,
          payload: job.data || {},
        });
        return {
          success: false,
          ignored: true,
          shop,
          shopifyBulkOperationId,
          reason: "unresolved_bulk_operation_owner_persisted",
        };
      }

      return {
        success: false,
        ignored: true,
        reason: "non_mutation_bulk_operation",
        shop,
        shopifyBulkOperationId,
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
    shopifyBulkOperationId: job?.data?.admin_graphql_api_id,
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
    shopifyBulkOperationId: job?.data?.admin_graphql_api_id,
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
