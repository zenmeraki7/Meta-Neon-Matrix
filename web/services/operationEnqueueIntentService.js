import { db } from "../repositories/repositoryDb.js";
import { scheduledEditQueue } from "../Jobs/Queues/scheduledEditQueue.js";
import { enqueueBulkEditTargetFreezeJob } from "../Jobs/Queues/bulkEditPipelineJob.js";
import { addProductCreateJob } from "../Jobs/Queues/productCreateJob.js";
import { addProductUpdateJob } from "../Jobs/Queues/productUpdateJob.js";
import { addProductDeleteJob } from "../Jobs/Queues/productDeleteJob.js";
import { addAppUninstallJob } from "../Jobs/Queues/appUninstallJob.js";
import { addShopSyncJob } from "../Jobs/Queues/shopSyncJob.js";
import { addbulkOperatonQueryJob } from "../Jobs/Queues/bulkOperationQueryJob.js";
import { addbulkOperatonMutationJob } from "../Jobs/Queues/bulkOperationMutationJob.js";
import { enqueueScheduledExportExecutionJob } from "./scheduledExportExecutionService.js";
import { enqueueRecurringEditExecutionJob } from "./recurringEditExecutionService.js";
import { enqueueRetiredMirrorCleanup } from "../Jobs/Queues/mirrorCleanupQueue.js";
import { addbulkExportJob } from "../Jobs/Queues/bulkExportJob.js";
import { addProductSyncClearProductTypesJob } from "../Jobs/Queues/productSyncClearProductTypesJob.js";
import { bulkEditItemApplyQueue } from "../queues/adapters/jobsQueueInstancesAdapter.js";
import crypto from "node:crypto";
import { normalizeShopDomain } from "../utils/shopDomainUtils.js";
import {
  buildImmutablePayloadMetadata,
  verifyImmutablePayload,
} from "../utils/immutablePayloadUtils.js";
import {
  loadImmutablePayload,
  saveImmutablePayload,
} from "./storage/immutableObjectStorage.js";

export const ENQUEUE_INTENT_STATUS = Object.freeze({
  PENDING: "PENDING",
  DISPATCHING: "DISPATCHING",
  DISPATCHED: "DISPATCHED",
  FAILED: "FAILED",
});

export const ENQUEUE_QUEUE_KEYS = Object.freeze({
  SCHEDULED_EDIT: "SCHEDULED_EDIT",
  BULK_EDIT_PIPELINE: "BULK_EDIT_PIPELINE",
  PRODUCT_CREATE: "PRODUCT_CREATE",
  PRODUCT_UPDATE: "PRODUCT_UPDATE",
  PRODUCT_DELETE: "PRODUCT_DELETE",
  APP_UNINSTALL: "APP_UNINSTALL",
  SHOP_SYNC: "SHOP_SYNC",
  BULK_OPERATION_QUERY: "BULK_OPERATION_QUERY",
  BULK_OPERATION_MUTATION: "BULK_OPERATION_MUTATION",
  SCHEDULED_EXPORT_RUN: "SCHEDULED_EXPORT_RUN",
  RECURRING_EDIT_RUN: "RECURRING_EDIT_RUN",
  MIRROR_CLEANUP: "MIRROR_CLEANUP",
  EXPORT_JOB: "EXPORT_JOB",
  BULK_EDIT_ITEM_APPLY: "BULK_EDIT_ITEM_APPLY",
  PRODUCT_SYNC: "product_sync",
  COLLECTION_SYNC: "collection_sync",
  PRODUCT_SYNC_CLEAR_TYPES: "product_sync_clear_types",
});

function toObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

export async function createEnqueueIntent({
  tx = db,
  shop,
  queueRoutingKey,
  queueJobName,
  payload,
  options = {},
  dispatchScope = null,
  dispatchDedupeKey = null,
  availableAt = new Date(),
}) {
  const canonicalShop = normalizeShopDomain(shop);
  const scope = String(dispatchScope || queueRoutingKey || "").trim();
  const dedupeKey = String(dispatchDedupeKey || "").trim();
  if (!canonicalShop || !scope || !dedupeKey) throw new Error("ENQUEUE_INTENT_DEDUPE_REQUIRED");
  if (scope.length > 120 || dedupeKey.length > 512) throw new Error("ENQUEUE_INTENT_DEDUPE_TOO_LONG");
  let storedPayload = payload;
  let payloadMetadata;
  try {
    payloadMetadata = buildImmutablePayloadMetadata({ payload, operationType: "OPERATION_ENQUEUE_INTENT" });
  } catch (error) {
    if (error?.code !== "PAYLOAD_EXTERNAL_STORAGE_REQUIRED") throw error;
    const stored = await saveImmutablePayload({ shop: canonicalShop, payload });
    payloadMetadata = buildImmutablePayloadMetadata({
      payload,
      operationType: "OPERATION_ENQUEUE_INTENT",
      storageKey: stored.storageKey,
    });
    storedPayload = { externalPayload: true, payloadHash: payloadMetadata.payloadHash };
  }
  const id = crypto.randomUUID();
  await tx.operationEnqueueIntent.createMany({
    data: [{
      id,
      shop: canonicalShop,
      queueRoutingKey,
      queueJobName,
      payload: storedPayload,
      ...payloadMetadata,
      options,
      dispatchScope: scope,
      dispatchDedupeKey: dedupeKey,
      status: ENQUEUE_INTENT_STATUS.PENDING,
      nextAttemptAt: availableAt,
    }],
    skipDuplicates: true,
  });
  return tx.operationEnqueueIntent.findFirst({
    where: { shop: canonicalShop, dispatchScope: scope, dispatchDedupeKey: dedupeKey },
  });
}

async function dispatchIntent(intent) {
  const authoritativePayload = intent.payloadStorageKey
    ? await loadImmutablePayload({ storageKey: intent.payloadStorageKey, expectedHash: intent.payloadHash })
    : intent.payload;
  verifyImmutablePayload(authoritativePayload, {
    operationType: "OPERATION_ENQUEUE_INTENT",
    payloadHash: intent.payloadHash,
    payloadByteSize: intent.payloadByteSize,
    payloadSchemaVersion: intent.payloadSchemaVersion,
    payloadCompression: intent.payloadCompression,
    payloadStorageKey: intent.payloadStorageKey,
  });
  const payload = toObject(authoritativePayload, {});
  const options = { ...toObject(intent.options, {}), jobId: intent.id };

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.SCHEDULED_EDIT) {
    await scheduledEditQueue.add(intent.queueJobName, payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.BULK_EDIT_PIPELINE) {
    await enqueueBulkEditTargetFreezeJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.PRODUCT_CREATE) {
    await addProductCreateJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.PRODUCT_UPDATE) {
    await addProductUpdateJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.PRODUCT_DELETE) {
    await addProductDeleteJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.APP_UNINSTALL) {
    await addAppUninstallJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.SHOP_SYNC) {
    await addShopSyncJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.BULK_OPERATION_QUERY) {
    await addbulkOperatonQueryJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.BULK_OPERATION_MUTATION) {
    await addbulkOperatonMutationJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.SCHEDULED_EXPORT_RUN) {
    await enqueueScheduledExportExecutionJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.RECURRING_EDIT_RUN) {
    await enqueueRecurringEditExecutionJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.MIRROR_CLEANUP) {
    await enqueueRetiredMirrorCleanup(payload);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.EXPORT_JOB) {
    await addbulkExportJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.BULK_EDIT_ITEM_APPLY) {
    await bulkEditItemApplyQueue.add(intent.queueJobName, payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.PRODUCT_SYNC_CLEAR_TYPES) {
    await addProductSyncClearProductTypesJob(payload, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.PRODUCT_SYNC) {
    await addShopSyncJob({ shopDomain: payload.shopUrl || payload.shop, syncType: "product", reason: payload.syncReason }, options);
    return;
  }

  if (intent.queueRoutingKey === ENQUEUE_QUEUE_KEYS.COLLECTION_SYNC) {
    await addShopSyncJob({ shopDomain: payload.shop, syncType: "collection", reason: "collection_refresh" }, options);
    return;
  }

  throw new Error(`Unsupported enqueue queue key: ${intent.queueRoutingKey}`);
}

export async function dispatchPendingEnqueueIntents({
  shop = null,
  queueRoutingKey = null,
  limit = 50,
  staleAfterMs = 5 * 60 * 1000,
}) {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + staleAfterMs);
  const dispatchOwnerId = crypto.randomUUID();
  const dispatchClaimToken = crypto.randomUUID();
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 500));
  const intents = await db.$queryRaw`
    WITH candidates AS (
      SELECT "id"
      FROM "OperationEnqueueIntent"
      WHERE (${shop}::text IS NULL OR "shop" = ${shop})
        AND (${queueRoutingKey}::text IS NULL OR "queueKey" = ${queueRoutingKey})
        AND (
          ("status" = 'PENDING'::"OperationEnqueueIntentStatus" AND "nextAttemptAt" <= ${now})
          OR (
            "status" = 'DISPATCHING'::"OperationEnqueueIntentStatus"
            AND "dispatchLeaseExpiresAt" < ${now}
          )
        )
      ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "id" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${boundedLimit}
    )
    UPDATE "OperationEnqueueIntent" intent
    SET "status" = 'DISPATCHING'::"OperationEnqueueIntentStatus",
        "attempts" = intent."attempts" + 1,
        "dispatchStartedAt" = ${now},
        "dispatchHeartbeatAt" = ${now},
        "dispatchOwner" = ${dispatchOwnerId},
        "dispatchLeaseExpiresAt" = ${leaseExpiresAt},
        "dispatchClaimToken" = ${dispatchClaimToken},
        "dispatchFencingToken" = intent."dispatchFencingToken" + 1,
        "updatedAt" = ${now}
    FROM candidates
    WHERE intent."id" = candidates."id"
    RETURNING intent."id", intent."shop", intent."payload", intent."options",
      intent."payloadHash", intent."payloadByteSize", intent."payloadSchemaVersion",
      intent."payloadCompression", intent."payloadStorageKey",
      intent."queueKey" AS "queueRoutingKey",
      intent."jobName" AS "queueJobName", intent."dispatchClaimToken",
      intent."dispatchFencingToken", intent."attempts" AS "dispatchAttemptCount",
      intent."dedupeKey" AS "dispatchDedupeKey"
  `;

  let dispatched = 0;
  let failed = 0;

  for (const intent of intents) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await dispatchIntent(intent);
      // eslint-disable-next-line no-await-in-loop
      await db.operationEnqueueIntent.updateMany({
        where: {
          id: intent.id,
          shop: intent.shop,
          status: ENQUEUE_INTENT_STATUS.DISPATCHING,
          dispatchOwnerId,
          dispatchClaimToken: intent.dispatchClaimToken,
          dispatchFencingToken: intent.dispatchFencingToken,
        },
        data: {
          status: ENQUEUE_INTENT_STATUS.DISPATCHED,
          dispatchedAt: new Date(),
          lastError: null,
          dispatchHeartbeatAt: new Date(),
          dispatchOwnerId: null,
          dispatchLeaseExpiresAt: null,
          dispatchClaimToken: null,
        },
      });
      dispatched += 1;
    } catch (error) {
      // eslint-disable-next-line no-await-in-loop
      await db.operationEnqueueIntent.updateMany({
        where: {
          id: intent.id,
          shop: intent.shop,
          status: ENQUEUE_INTENT_STATUS.DISPATCHING,
          dispatchOwnerId,
          dispatchClaimToken: intent.dispatchClaimToken,
          dispatchFencingToken: intent.dispatchFencingToken,
        },
        data: {
          status: ENQUEUE_INTENT_STATUS.PENDING,
          lastErrorCode: error?.code || "QUEUE_DISPATCH_FAILED",
          lastError: error?.message || String(error),
          dispatchStartedAt: null,
          dispatchHeartbeatAt: null,
          dispatchOwnerId: null,
          dispatchLeaseExpiresAt: null,
          dispatchClaimToken: null,
          nextAttemptAt: new Date(Date.now() + Math.min(15 * 60_000, 5_000 * (2 ** Math.max(0, Number(intent.dispatchAttemptCount || 1) - 1)))),
        },
      });
      failed += 1;
    }
  }

  return {
    scanned: intents.length,
    dispatched,
    failed,
  };
}

export async function heartbeatEnqueueIntentClaim({
  intentId,
  shop,
  dispatchOwnerId,
  dispatchClaimToken,
  dispatchFencingToken,
}) {
  return db.operationEnqueueIntent.updateMany({
    where: {
      id: intentId,
      shop,
      status: ENQUEUE_INTENT_STATUS.DISPATCHING,
      dispatchOwnerId,
      dispatchClaimToken,
      dispatchFencingToken,
    },
    data: {
      dispatchHeartbeatAt: new Date(),
      dispatchLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });
}
