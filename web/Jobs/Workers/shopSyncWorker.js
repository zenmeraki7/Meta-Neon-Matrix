import crypto from "node:crypto";
import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { Services } from "../../services/productService/productFilterService.js";
import { CollectionService } from "../../services/collectionService/CollectionService.js";
import shopify from "../../shopify.js";
import {
  markCollectionReconciliationPending,
  markInventoryReconciliationPending,
  markRepairRequired,
  MIRROR_STALE_REASONS,
} from "../../services/mirrorHealthService.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import {
  acquireExclusiveShopWork,
  releaseExclusiveShopWork,
} from "../../services/shopWorkLeaseService.js";
import {
  getJobAttempt,
  isRetryExhausted,
  recordRetryExhausted,
} from "../../utils/workerTelemetry.js";
import { SHOP_SYNC_QUEUE_NAME } from "../../queues/shopSyncQueue.constants.js";
import { shopSyncDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { requireShopDomain, requireStoreId } from "../../utils/identity.js";

/** @typedef {import("../../types/identity.js").StoreId} StoreId */
/** @typedef {import("../../types/identity.js").ShopDomain} ShopDomain */

const QUEUE_NAME = SHOP_SYNC_QUEUE_NAME;
const MIRROR_SYNC_OPERATION_TYPE = "MIRROR_SYNC";
const MIRROR_SYNC_TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const ACTIVE_BULK_OPERATION_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);
const SUPPORTED_SYNC_TYPES = new Set(["product", "collection"]);

function normalizeKeyPart(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
}

function createServices() {
  return {
    productService: new Services(),
    collectionService: new CollectionService(shopify),
  };
}

function willExhaustRetry(job) {
  const maxAttempts = Number(job?.opts?.attempts || 1);
  return Number(job?.attemptsMade || 0) + 1 >= maxAttempts;
}

function isAuthGone(error) {
  const status = error?.response?.status || error?.statusCode || error?.status;
  return status === 401 || status === 403;
}

function assertSyncStartResult(result, syncType) {
  if (!result || typeof result !== "object") {
    throw new Error(`INVALID_${syncType.toUpperCase()}_SYNC_RESULT`);
  }
  if (!result.syncHistoryId && !result.shopifyBulkOperationId) {
    throw new Error(`MISSING_${syncType.toUpperCase()}_SYNC_IDENTIFIERS`);
  }
  return {
    syncHistoryId: result.syncHistoryId || null,
    shopifyBulkOperationId: result.shopifyBulkOperationId || null,
  };
}

function shouldMarkMirrorRepairRequired(error) {
  const message = String(error?.message || "");
  return ![
    "SHOP_SYNC_LOCK_BUSY",
    "SHOPIFY_QUERY_BULK_OPERATION_ACTIVE",
    "SHOPIFY_BULK_SUBMIT_LOCK_BUSY",
    "Another heavy job is already running for this shop",
  ].some((code) => message.includes(code));
}

async function acquireShopSyncLock({ redis, shop, syncType, ttlMs = 15 * 60 * 1000 }) {
  const key = `lock:shop:${normalizeKeyPart(shop)}:sync:${normalizeKeyPart(syncType)}`;
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, "NX", "PX", ttlMs);
  return acquired === "OK" ? { key, token } : null;
}

async function releaseShopSyncLock({ redis, key, token }) {
  if (!key || !token) return;
  await redis.eval(
    `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
    `,
    1,
    key,
    token,
  );
}

async function transitionMirrorSyncLedger({
  shop,
  syncOperationId,
  from,
  to,
  data = {},
}) {
  const result = await db.operationFingerprint.updateMany({
    where: {
      id: syncOperationId,
      shop,
      operationType: MIRROR_SYNC_OPERATION_TYPE,
      status: Array.isArray(from) ? { in: from } : from,
    },
    data: {
      status: to,
      ...data,
      updatedAt: new Date(),
    },
  });
  return result.count === 1;
}

async function processShopSyncJob(job) {
  const { storeId: rawStoreId, shopDomain: rawShopDomain, syncType, reason, syncOperationId } = job.data || {};
  const storeId = requireStoreId(rawStoreId);
  const shopDomain = requireShopDomain(rawShopDomain);
  if (!shopDomain || !syncType || !syncOperationId) {
    throw new Error("shop-sync job requires shopDomain, syncType, syncOperationId");
  }
  if (!storeId) {
    throw new Error("shop-sync job requires storeId");
  }
  const shop = shopDomain;
  const normalizedSyncType = syncType === "FULL_SYNC" ? "product" : syncType;
  if (!SUPPORTED_SYNC_TYPES.has(normalizedSyncType)) {
    throw new Error(`UNSUPPORTED_SHOP_SYNC_TYPE:${syncType}`);
  }

  logger.info("Shop sync worker started", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId: job.id,
    queueJobName: job.name,
    shop: shopDomain,
    storeId,
    syncType,
    syncOperationId,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts?.attempts,
  });
  await job.updateProgress({ stage: "validated", percent: 10 });

    const store = await db.store.findUnique({
      where: {
        id: storeId,
      },
      select: {
        id: true,
        shopUrl: true,
        installationStatus: true,
      },
    });

    const storeIdentityMatches = Boolean(
      store
      && store.id === storeId
      && store.shopUrl === shopDomain,
    );

    if (store && !storeIdentityMatches) {
      logger.warn("storeId/shopUrl mismatch in shop sync job payload", {
        worker: "shopSyncWorker",
        queue: QUEUE_NAME,
        storeId,
        shopDomain,
        actualStoreId: store.id,
        actualShopUrl: store.shopUrl,
      });
    }

    const isUninstalled = store?.installationStatus === "UNINSTALLED";
    if (!store || isUninstalled || !storeIdentityMatches) {
      await transitionMirrorSyncLedger({
        shop: shopDomain,
        syncOperationId,
        from: ["STARTING_BULK_QUERY", "SUBMITTING", "RETRYABLE_FAILURE", "QUEUED"],
        to: "CANCELLED",
        data: {
          lastError: !store
            ? "SHOP_NOT_FOUND"
            : isUninstalled
              ? "SHOP_UNINSTALLED"
              : "STORE_IDENTITY_MISMATCH",
        },
      }).catch(() => {});

      return {
        skipped: true,
        reason: !store
          ? "shop_not_found"
          : isUninstalled
            ? "shop_uninstalled"
            : "store_identity_mismatch",
      };
    }

  const submissionLock = await acquireShopSyncLock({
    redis: connection,
    shop: shopDomain,
    syncType,
  });
  if (!submissionLock) {
    const lockBusyError = new Error("SHOP_SYNC_LOCK_BUSY");
    lockBusyError.code = "RETRYABLE_LOCK_BUSY";
    lockBusyError.retryable = true;
    throw lockBusyError;
  }

  let exclusiveShopLockKey = null;

  try {
    const movedToStarting = await transitionMirrorSyncLedger({
      shop,
      syncOperationId,
      from: ["QUEUED", "RETRYABLE_FAILURE"],
      to: "STARTING_BULK_QUERY",
      data: { lastError: null },
    });

    if (!movedToStarting) {
      const latest = await db.operationFingerprint.findFirst({
        where: {
          id: syncOperationId,
          shop,
          operationType: MIRROR_SYNC_OPERATION_TYPE,
        },
        select: { status: true, resourceId: true, fingerprintResourceType: true },
      });
      if (MIRROR_SYNC_TERMINAL_STATUSES.has(String(latest?.status || "").toUpperCase())) {
        return {
          skipped: true,
          reason: "mirror_sync_already_terminal",
          syncOperationId,
        };
      }
      if (
        latest?.status === "RUNNING"
        && latest?.fingerprintResourceType === "shopify_bulk_operation"
        && latest?.resourceId
      ) {
        return {
          skipped: true,
          reason: "shopify_bulk_operation_already_submitted",
          shopifyBulkOperationId: latest.resourceId,
        };
      }
      throw new Error(`MIRROR_SYNC_NOT_CLAIMABLE_FROM_${latest?.status || "UNKNOWN"}`);
    }

    await job.updateProgress({ stage: "ledger_claimed", percent: 20 });

    const exclusiveLock = await acquireExclusiveShopWork({
      shop,
      activity: `shop_${syncType}_sync`,
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
      jobId: job.id,
      entityType: "store",
      entityId: shop,
      executionId: `${syncType}:${shop}`,
    });

    if (!exclusiveLock.acquired) {
      const lockBusyError = new Error("Another heavy job is already running for this shop");
      lockBusyError.code = "RETRYABLE_LOCK_BUSY";
      lockBusyError.retryable = true;
      throw lockBusyError;
    }

    exclusiveShopLockKey = exclusiveLock.lockKey;

    const submitting = await db.operationFingerprint.updateMany({
      where: {
        id: syncOperationId,
        shop,
        operationType: MIRROR_SYNC_OPERATION_TYPE,
        status: "STARTING_BULK_QUERY",
        resourceId: null,
      },
      data: {
        status: "SUBMITTING",
        updatedAt: new Date(),
      },
    });

    if (submitting.count !== 1) {
      throw new Error("MIRROR_SYNC_SUBMIT_FENCE_NOT_ACQUIRED");
    }

    if (normalizedSyncType === "product") {
      await markInventoryReconciliationPending(shop).catch(() => {});
    }
    if (normalizedSyncType === "collection") {
      await markCollectionReconciliationPending(shop).catch(() => {});
    }

    let session;
    let bulkStatus;
    try {
      session = await getSession(shop);
      bulkStatus = await getCurrentBulkOperationStatus(session, "QUERY");
    } catch (error) {
      if (isAuthGone(error)) {
        await transitionMirrorSyncLedger({
          shop,
          syncOperationId,
          from: ["STARTING_BULK_QUERY", "SUBMITTING", "RUNNING", "RETRYABLE_FAILURE"],
          to: "CANCELLED",
          data: { lastError: "SHOPIFY_AUTH_REVOKED_OR_SHOP_UNINSTALLED" },
        }).catch(() => {});
        return {
          skipped: true,
          reason: "shopify_auth_revoked_or_shop_uninstalled",
        };
      }
      throw error;
    }
    await job.updateProgress({ stage: "session_loaded", percent: 25 });

    const status = String(bulkStatus?.status || "").toUpperCase();
    if (ACTIVE_BULK_OPERATION_STATUSES.has(status)) {
      const e = new Error(`SHOPIFY_QUERY_BULK_OPERATION_ACTIVE:${status}`);
      e.retryable = true;
      throw e;
    }
    await job.updateProgress({ stage: "bulk_status_checked", percent: 40 });

    const existingSubmission = await db.operationFingerprint.findFirst({
      where: {
        id: syncOperationId,
        shop,
        operationType: MIRROR_SYNC_OPERATION_TYPE,
      },
      select: {
        status: true,
        resourceId: true,
        fingerprintResourceType: true,
      },
    });
    if (
      existingSubmission?.status === "RUNNING"
      && existingSubmission?.fingerprintResourceType === "shopify_bulk_operation"
      && existingSubmission?.resourceId
    ) {
      return {
        skipped: true,
        reason: "shopify_bulk_operation_already_submitted",
        shopifyBulkOperationId: existingSubmission.resourceId,
      };
    }

    const { productService, collectionService } = createServices();
    const syncResult = normalizedSyncType === "product"
      ? await productService.startBulkOperationToFetchProducts({ session })
      : await collectionService.clearCollections(session);

    const startResult = assertSyncStartResult(syncResult, syncType);
    if (!startResult.shopifyBulkOperationId) {
      throw new Error("SHOPIFY_BULK_OPERATION_ID_MISSING");
    }
    await job.updateProgress({ stage: "bulk_operation_started", percent: 80 });

    const transitionedToRunning = await transitionMirrorSyncLedger({
      shop,
      syncOperationId,
      from: "SUBMITTING",
      to: "RUNNING",
      data: {
        fingerprintResourceType: "shopify_bulk_operation",
        resourceId: String(startResult.shopifyBulkOperationId),
        lastError: null,
      },
    });
    if (!transitionedToRunning) {
      await transitionMirrorSyncLedger({
        shop,
        syncOperationId,
        from: "SUBMITTING",
        to: "RECONCILE_SUBMITTED",
        data: {
          fingerprintResourceType: "shopify_bulk_operation",
          resourceId: String(startResult.shopifyBulkOperationId),
          lastError: "RUNNING transition failed after Shopify accepted bulk operation",
        },
      }).catch(() => {});
      throw Object.assign(
        new Error("MIRROR_SYNC_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE"),
        { retryable: false },
      );
    }
    await job.updateProgress({ stage: "ledger_running", percent: 100 });

    return {
      success: true,
      shop,
      syncType,
      syncOperationId,
      shopifyBulkOperationId: String(startResult.shopifyBulkOperationId),
      syncHistoryId: startResult.syncHistoryId,
    };
  } catch (error) {
    if (error.message === "MIRROR_SYNC_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE") {
      throw error;
    }

    const retryable =
      error.retryable
      || error.code === "RETRYABLE_LOCK_BUSY"
      || String(error.message || "").includes("SHOPIFY_QUERY_BULK_OPERATION_ACTIVE");

    await transitionMirrorSyncLedger({
      shop,
      syncOperationId,
      from: ["QUEUED", "RETRYABLE_FAILURE", "STARTING_BULK_QUERY", "SUBMITTING", "RUNNING"],
      to: retryable && !willExhaustRetry(job) ? "RETRYABLE_FAILURE" : "FAILED",
      data: { lastError: error.message || String(error) },
    }).catch(() => {});

    if (shouldMarkMirrorRepairRequired(error)) {
      await recordMirrorAnomaly({
        shop,
        severity: "medium",
        type: "shop_sync_worker_failure",
        entityType: "store",
        entityId: shop,
        message: error.message,
        details: { syncType, reason },
      }).catch(() => {});

      await markRepairRequired({
        shop,
        reason:
          syncType === "collection"
            ? MIRROR_STALE_REASONS.COLLECTION_RECONCILIATION_PENDING
            : MIRROR_STALE_REASONS.INVENTORY_RECONCILIATION_PENDING,
        summary: error.message,
        severity: "medium",
        details: { syncType, reason },
      }).catch(() => {});
    }

    throw error;
  } finally {
    if (exclusiveShopLockKey) {
      await releaseExclusiveShopWork(exclusiveShopLockKey);
    }
    await releaseShopSyncLock({
      redis: connection,
      key: submissionLock?.key,
      token: submissionLock?.token,
    }).catch(() => {});
  }
}

const shopSyncWorker = new Worker(QUEUE_NAME, processShopSyncJob, {
  connection,
  concurrency: Number(process.env.SHOP_SYNC_CONCURRENCY || 2),
  lockDuration: Number(process.env.SHOP_SYNC_LOCK_DURATION_MS || 600000),
  stalledInterval: Number(process.env.SHOP_SYNC_STALLED_INTERVAL_MS || 60000),
  maxStalledCount: Number(process.env.SHOP_SYNC_MAX_STALLED_COUNT || 1),
  limiter: {
    max: Number(process.env.SHOP_SYNC_GLOBAL_LIMIT_MAX || 10),
    duration: Number(process.env.SHOP_SYNC_GLOBAL_LIMIT_DURATION_MS || 1000),
  },
});

const shopSyncQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection(),
});
shopSyncQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Shop sync queue event failed", {
    queue: QUEUE_NAME,
    jobId,
    failedReason,
  });
});
shopSyncQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Shop sync queue event stalled", {
    queue: QUEUE_NAME,
    jobId,
  });
});

shopSyncWorker.on("error", (error) => {
  logger.error("Shop sync worker runtime error", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    message: error.message,
    stack: error.stack,
  });
});

shopSyncWorker.on("stalled", (jobId) => {
  logger.warn("Shop sync worker job stalled", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId,
  });
});

shopSyncWorker.on("failed", (job, error) => {
  logger.error("Shop sync worker failed", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    queueJobName: job?.name,
    shopDomain: job?.data?.shopDomain,
    syncType: job?.data?.syncType,
    syncOperationId: job?.data?.syncOperationId || null,
    attemptsMade: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts,
    retryExhausted: isRetryExhausted(job),
    message: error?.message,
    stack: error?.stack,
    data: job?.data,
  });

  if (!isRetryExhausted(job)) return;
  void shopSyncDlqQueue.add(
    "shop-sync-dlq",
    {
      originalQueue: QUEUE_NAME,
      originalJobId: job?.id,
      originalJobName: job?.name,
      data: job?.data,
      failedReason: error?.message,
      stack: error?.stack,
      failedAt: new Date().toISOString(),
    },
    {
      jobId: `dlq:${QUEUE_NAME}:${job?.id}`,
      removeOnComplete: { age: 604800, count: 5000 },
    },
  ).catch((dlqErr) => {
    logger.error("Shop sync DLQ enqueue failed", {
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
      originalJobId: job?.id,
      message: dlqErr?.message,
      stack: dlqErr?.stack,
    });
  });

  void recordRetryExhausted({
    job,
    shop: job?.data?.shopDomain,
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    entityType: "store",
    entityId: job?.data?.shopDomain,
    executionId: `${job?.data?.syncType || "sync"}:${job?.data?.shopDomain || "unknown"}`,
    message: "Shop sync worker exhausted retries",
    details: {
      syncType: job?.data?.syncType || null,
      originalError: error?.message,
    },
  }).catch((recordError) => {
    logger.error("Failed to record retry exhaustion", {
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
      jobId: job?.id,
      shopDomain: job?.data?.shopDomain,
      message: recordError.message,
      stack: recordError.stack,
    });
  });
});

shopSyncWorker.on("completed", async (job, result) => {
  logger.info("Shop sync worker completed", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shopDomain: job?.data?.shopDomain,
    syncType: job?.data?.syncType,
    syncOperationId: job?.data?.syncOperationId || null,
    success: Boolean(result?.success),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });

  const { shopDomain, syncType } = job?.data || {};
  if (shopDomain && !result?.skipped && ["product", "FULL_SYNC"].includes(syncType)) {
    await db.store.updateMany({
      where: { shopUrl: shopDomain },
      data: { lastFullSyncAt: new Date() },
    }).catch((err) => {
      logger.error("Failed to write lastFullSyncAt", {
        worker: "shopSyncWorker",
        shopDomain,
        message: err.message,
      });
    });

 
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Closing shop sync worker", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    signal,
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("SHOP_SYNC_WORKER_CLOSE_TIMEOUT")), 25_000));
  try {
    await Promise.race([
      (async () => {
        await shopSyncWorker.close();
        await shopSyncQueueEvents.close();
      })(),
      timeout,
    ]);
    logger.info("Shop sync worker closed", {
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
    });
  } catch (error) {
    logger.error("Shop sync worker shutdown failed", {
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
      message: error.message,
      stack: error.stack,
    });
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

export default shopSyncWorker;
