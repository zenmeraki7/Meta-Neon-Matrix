import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import shopify from "../../shopify.js";
import logger from "../../utils/loggerUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { addbulkEditResultIngestJob } from "../Queues/bulkEditResultIngestJob.js";
import { addbulkUndoResultIngestJob } from "../Queues/bulkUndoResultIngestJob.js";
import { addbulkOperatonQueryJob } from "../Queues/bulkOperationQueryJob.js";
import { acquireRedisLock, releaseRedisLock } from "../../utils/redisLockUtils.js";
import { enqueueMissedBulkOperationPollingTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";
import { createMirrorBatchId } from "../../services/mirrorHealthService.js";

const QUEUE_NAME = "missed-bulk-operation-polling";
const POLL_COOLDOWN_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 60_000;
const LEADER_LOCK_KEY = "leader:missed-bulk-operation-polling:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;

const BULK_OPERATION_RESULT_QUERY = `#graphql
  query BulkOperationResult($id: ID!) {
    node(id: $id) {
      ... on BulkOperation { id status type url partialDataUrl query createdAt }
    }
  }
`;

const CURRENT_QUERY_OPERATION = `#graphql
  query CurrentQueryBulkOperation {
    currentBulkOperation(type: QUERY) {
      id status type url partialDataUrl query createdAt
    }
  }
`;

function terminal(status) {
  return new Set(["COMPLETED", "COMPLETED_WITH_ERRORS", "FAILED", "CANCELED", "CANCELLED", "EXPIRED"]).has(String(status || "").toUpperCase());
}

async function graphql(shop, query, variables = {}) {
  const session = await getSession(shop);
  if (!session?.shop || session.shop !== shop) throw new Error("SHOP_SESSION_UNAVAILABLE");
  const client = new shopify.api.clients.Graphql({ session });
  const response = await client.query({ data: { query, variables } });
  const errors = response?.body?.errors || [];
  if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
  return response?.body?.data || {};
}

async function recoverSubmittingMirrorSyncs() {
  const cutoff = new Date(Date.now() - 60_000);
  const attempts = await db.operationFingerprint.findMany({
    where: {
      operationType: "MIRROR_SYNC",
      status: { in: ["SUBMITTING", "RECONCILE_SUBMITTED"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true, shop: true, fingerprint: true, resourceId: true },
    take: 50,
    orderBy: { updatedAt: "asc" },
  });

  let recovered = 0;
  for (const attempt of attempts) {
    try {
      const data = await graphql(attempt.shop, CURRENT_QUERY_OPERATION);
      const operation = data?.currentBulkOperation;
      if (!operation?.id) continue;

      const syncType = String(attempt.fingerprint || "").startsWith("collection:") ? "Collection" : "Product";
      let history = await db.syncHistory.findFirst({
        where: { shop: attempt.shop, shopifyBulkOperationId: operation.id },
        orderBy: { createdAt: "desc" },
      });

      if (!history) {
        const mirrorBatchId = createMirrorBatchId(syncType === "Collection" ? "collection_sync" : "product_sync");
        history = await db.$transaction(async (tx) => {
          const store = await tx.store.findUnique({
            where: { shopUrl: attempt.shop },
            select: { currentProductMirrorBatchId: true, currentCollectionMirrorBatchId: true },
          });
          const created = await tx.syncHistory.create({
            data: {
              shop: attempt.shop,
              shopifyBulkOperationId: operation.id,
              mirrorBatchId,
              status: "processing",
              stage: "SHOPIFY_BULK_RUNNING",
              operationType: syncType,
              recordCount: 0,
              duration: 0,
            },
          });
          const latest = await tx.mirrorMutationJournal.findFirst({
            where: { shop: attempt.shop },
            orderBy: { sequence: "desc" },
            select: { sequence: true },
          });
          await tx.mirrorBatch.create({
            data: {
              id: mirrorBatchId,
              shop: attempt.shop,
              syncHistoryId: created.id,
              shopifyBulkOperationId: operation.id,
              mirrorResourceType: syncType === "Collection" ? "COLLECTION_CATALOG" : "PRODUCT_CATALOG",
              status: "BULK_OPERATION_STARTED",
              expectedPreviousActiveBatchId: syncType === "Collection" ? store?.currentCollectionMirrorBatchId || null : store?.currentProductMirrorBatchId || null,
              replayStartSequence: latest?.sequence ?? 0n,
            },
          });
          return created;
        }, { isolationLevel: "Serializable", maxWait: 10000, timeout: 20000 });
      }

      await db.operationFingerprint.updateMany({
        where: { id: attempt.id, shop: attempt.shop, status: { in: ["SUBMITTING", "RECONCILE_SUBMITTED"] } },
        data: {
          status: "RUNNING",
          fingerprintResourceType: "shopify_bulk_operation",
          resourceId: operation.id,
          lastError: null,
          updatedAt: new Date(),
        },
      });

      if (terminal(operation.status)) {
        await addbulkOperatonQueryJob({
          shop: attempt.shop,
          admin_graphql_api_id: operation.id,
          id: operation.id,
          type: "QUERY",
          source: "submission_recovery",
        });
      }
      recovered += 1;
    } catch (error) {
      logger.error("Mirror submission recovery failed", { shop: attempt.shop, attemptId: attempt.id, message: error.message });
    }
  }
  return recovered;
}

async function pollExistingOperations() {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000);
  const [edits, syncs] = await Promise.all([
    db.editHistory.findMany({
      where: {
        OR: [
          { executionState: { in: [OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING, OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS] }, updatedAt: { lt: cutoff } },
          { undo: { path: ["status"], equals: "processing" }, updatedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, shop: true, executionIdentity: true, shopifyBulkOperationId: true, batch: true, undo: true },
      take: 50,
      orderBy: { updatedAt: "asc" },
    }),
    db.syncHistory.findMany({
      where: { status: "processing", shopifyBulkOperationId: { not: null }, updatedAt: { lt: cutoff } },
      select: { id: true, shop: true, shopifyBulkOperationId: true },
      take: 50,
      orderBy: { updatedAt: "asc" },
    }),
  ]);

  let enqueued = 0;
  for (const history of edits) {
    const undo = history.undo || {};
    const isUndo = undo?.status === "processing" && undo?.state === "awaiting_shopify" && undo?.shopifyBulkOperationId;
    const shopifyBulkOperationId = String(isUndo ? undo.shopifyBulkOperationId : history.batch?.shopifyBulkOperation?.id || history.batch?.shopifyBulkOperationId || history.shopifyBulkOperationId || "");
    if (!shopifyBulkOperationId) continue;
    const claimed = await connection.set(`missed-webhook-poll:${history.shop}:${shopifyBulkOperationId}`, String(Date.now()), "NX", "PX", POLL_COOLDOWN_MS);
    if (claimed !== "OK") continue;
    const data = await graphql(history.shop, BULK_OPERATION_RESULT_QUERY, { id: shopifyBulkOperationId });
    const operation = data?.node;
    if (!terminal(operation?.status)) continue;
    if (isUndo) await addbulkUndoResultIngestJob({ shop: history.shop, shopifyBulkOperationId, source: "missed_webhook_polling" });
    else await addbulkEditResultIngestJob({ shop: history.shop, shopifyBulkOperationId, executionId: history.executionIdentity || null, source: "missed_webhook_polling" });
    enqueued += 1;
  }

  for (const sync of syncs) {
    const shopifyBulkOperationId = String(sync.shopifyBulkOperationId || "");
    if (!shopifyBulkOperationId) continue;
    const claimed = await connection.set(`missed-webhook-poll:${sync.shop}:${shopifyBulkOperationId}`, String(Date.now()), "NX", "PX", POLL_COOLDOWN_MS);
    if (claimed !== "OK") continue;
    const data = await graphql(sync.shop, BULK_OPERATION_RESULT_QUERY, { id: shopifyBulkOperationId });
    if (!terminal(data?.node?.status)) continue;
    await addbulkOperatonQueryJob({ shop: sync.shop, admin_graphql_api_id: shopifyBulkOperationId, id: shopifyBulkOperationId, type: "QUERY", source: "missed_webhook_polling" });
    enqueued += 1;
  }
  return enqueued;
}

async function poll() {
  const recovered = await recoverSubmittingMirrorSyncs();
  const enqueued = await pollExistingOperations();
  return { recovered, enqueued };
}

export const missedBulkOperationPollingWorker = new Worker(QUEUE_NAME, poll, { connection, concurrency: 1 });
missedBulkOperationPollingWorker.on("failed", (job, error) => logger.error("Missed bulk operation polling failed", { jobId: job?.id, message: error.message }));

async function registerRepeatableTick() {
  const lock = await acquireRedisLock({ connection, key: LEADER_LOCK_KEY, ttlMs: LEADER_LOCK_TTL_MS });
  if (!lock.acquired) return;
  try { await enqueueMissedBulkOperationPollingTick(POLL_INTERVAL_MS); }
  finally { await releaseRedisLock({ connection, key: lock.key, token: lock.token }).catch(() => {}); }
}
await registerRepeatableTick().catch((error) => logger.error("Missed operation scheduler registration failed", { message: error.message }));
export default missedBulkOperationPollingWorker;
