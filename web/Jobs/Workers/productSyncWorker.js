import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { Services } from "../../services/productService/productFilterService.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import {
  enqueueProductSyncExecutionJob,
  seedProductSyncOperation,
} from "../Queues/productSyncQueue.js";
import { db } from "../../repositories/repositoryDb.js";
import shopify from "../../shopify.js";
import {
  acquireRedisLock,
  releaseRedisLock,
  renewRedisLock,
} from "../../utils/redisLockUtils.js";
import { enforceShopRateLimit } from "../../utils/shopRateLimit.js";
import logger from "../../utils/loggerUtils.js";
import {
  PRODUCT_SYNC_DLQ_QUEUE_NAME,
  PRODUCT_SYNC_QUEUE_NAME,
  PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
} from "../../queues/productSyncQueue.constants.js";
import { productSyncDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const PRODUCT_SYNC_JOB_NAMES = new Set([
  "schedule-all-product-syncs",
  "auto-sync",
  "priority-sync",
  "store-product-sync",
  "manual-product-sync",
]);
const PRODUCT_SYNC_OPERATION_STATUSES = new Set([
  "QUEUED",
  "SUBMITTING",
  "RUNNING",
  "RETRYABLE_FAILURE",
  "FAILED",
  "ENQUEUE_FAILED",
  "RECONCILE_SUBMITTED",
  "COMPLETED",
  "CANCELLED",
  "CANCEL_REQUESTED",
]);
const ACTIVE_BULK_OPERATION_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);
const HEARTBEAT_INTERVAL_MS = 60_000;
const LOCK_TTL_MS = 10 * 60 * 1000;
const PRODUCT_SYNC_STALE_MS = 2 * 60 * 60 * 1000;
const AUTO_SYNC_BATCH_SIZE = Number(process.env.AUTO_SYNC_BATCH_SIZE || 10);
const PRIORITY_SYNC_BATCH_SIZE = Number(process.env.PRIORITY_SYNC_BATCH_SIZE || 5);
const ALL_STORES_SYNC_BATCH_SIZE = Number(process.env.ALL_STORES_SYNC_BATCH_SIZE || 20);
const ALL_STORES_SYNC_BATCH_DELAY_MS = Number(process.env.ALL_STORES_SYNC_BATCH_DELAY_MS || 50);

function normalizeKeyPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
}

function buildDeterministicOperationId({
  shopUrl,
  reason,
  windowStart,
  idempotencyKey,
}) {
  return [
    "product-sync-op",
    normalizeKeyPart(shopUrl),
    normalizeKeyPart(reason),
    normalizeKeyPart(idempotencyKey || windowStart),
  ].join(":");
}

function toIsoHourWindowStart(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function isStaleWindow(windowStart, maxAgeMs = PRODUCT_SYNC_STALE_MS) {
  if (!windowStart) return false;
  const startedAt = new Date(windowStart).getTime();
  return Number.isFinite(startedAt) && Date.now() - startedAt > maxAgeMs;
}

function isNonRetryableProductSyncError(error) {
  return Boolean(error?.nonRetryable) || [
    "OFFLINE_SESSION_NOT_FOUND",
    "SHOP_UNINSTALLED_SKIP_PRODUCT_SYNC",
    "PRODUCT_SYNC_CANCELLED_BEFORE_SUBMIT",
  ].includes(error?.message);
}

async function acquireShopLock(shopUrl, ttlMs = LOCK_TTL_MS) {
  const key = `lock:product_sync:${normalizeKeyPart(shopUrl)}`;
  const lock = await acquireRedisLock({
    connection,
    key,
    ttlMs,
  });
  return lock.acquired ? lock : null;
}

async function releaseShopLock(lock) {
  if (!lock?.acquired) return;
  await releaseRedisLock({
    connection,
    key: lock.key,
    token: lock.token,
  }).catch(() => {});
}

async function assertShopStillInstalled(shopUrl) {
  const store = await db.store.findUnique({
    where: { shopUrl },
    select: {
      id: true,
      isUnInstalled: true,
    },
  });
  if (!store || store.isUnInstalled) {
    const error = new Error("SHOP_UNINSTALLED_SKIP_PRODUCT_SYNC");
    error.nonRetryable = true;
    throw error;
  }
  return store;
}

async function assertProductSyncNotCancelled({ shopUrl, operationId }) {
  if (!operationId) return;
  const operation = await db.operationFingerprint.findFirst({
    where: {
      id: operationId,
      shop: shopUrl,
      operationType: "PRODUCT_SYNC",
    },
    select: { status: true },
  });
  if (["CANCELLED", "CANCEL_REQUESTED"].includes(operation?.status)) {
    const error = new Error("PRODUCT_SYNC_CANCELLED_BEFORE_SUBMIT");
    error.nonRetryable = true;
    throw error;
  }
}

async function claimStoreSync(shopUrl) {
  const staleCutoff = new Date(Date.now() - PRODUCT_SYNC_STALE_MS);
  const claimed = await db.store.updateMany({
    where: {
      shopUrl,
      isUnInstalled: false,
      OR: [
        { isProductSyncing: false },
        { productSyncStartedAt: { lt: staleCutoff } },
      ],
    },
    data: {
      isProductSyncing: true,
      productSyncStartedAt: new Date(),
      productSyncRecoveryRequired: false,
      lastProductSyncAttemptAt: new Date(),
      updatedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    const error = new Error("PRODUCT_SYNC_ALREADY_RUNNING");
    error.retryable = true;
    throw error;
  }
}

async function releaseStoreSyncClaim(shopUrl) {
  await db.store.updateMany({
    where: { shopUrl },
    data: {
      isProductSyncing: false,
      productSyncStartedAt: null,
      updatedAt: new Date(),
    },
  });
}

function getMaxAttempts(job) {
  return Number(job?.opts?.attempts || 1);
}

function hasExhaustedRetryFromFailedEvent(job) {
  // In BullMQ failed handlers, attemptsMade is already incremented for the failed run.
  return Number(job?.attemptsMade || 0) >= getMaxAttempts(job);
}

function willExhaustRetryFromProcessor(job) {
  // In processor catch paths, we are pre-failed, so compare attemptsMade + 1.
  return Number(job?.attemptsMade || 0) + 1 >= getMaxAttempts(job);
}

async function restoreSession(shop) {
  const sessionId = `offline_${shop}`;
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session?.accessToken) {
    const error = new Error("OFFLINE_SESSION_NOT_FOUND");
    error.nonRetryable = true;
    throw error;
  }
  return session;
}

function createProductService() {
  return new Services();
}

async function transitionProductSyncOp({
  operationId,
  shopUrl,
  from,
  to,
  data = {},
}) {
  if (!PRODUCT_SYNC_OPERATION_STATUSES.has(String(to))) {
    throw new Error(`INVALID_PRODUCT_SYNC_OPERATION_STATUS:${to}`);
  }
  return db.operationFingerprint.updateMany({
    where: {
      id: operationId,
      shop: shopUrl,
      operationType: "PRODUCT_SYNC",
      status: Array.isArray(from) ? { in: from } : from,
    },
    data: {
      status: to,
      ...data,
      updatedAt: new Date(),
    },
  });
}

async function seedAndEnqueueProductSyncJob({
  shopUrl,
  reason,
  windowStart,
  idempotencyKey,
}) {
  const deterministicOperationId = buildDeterministicOperationId({
    shopUrl,
    reason,
    windowStart,
    idempotencyKey,
  });

  const operationId = await seedProductSyncOperation({
    shopUrl,
    reason,
    operationId: deterministicOperationId,
    status: "QUEUED",
  });

  try {
    const enqueued = await enqueueProductSyncExecutionJob({
      shopUrl,
      syncReason: reason,
      windowStart,
      operationId,
    });
    if (enqueued?.skipped && enqueued.reason === "duplicate_job") {
      logger.info("Duplicate product sync execution job skipped", {
        shop: shopUrl,
        syncReason: reason,
        windowStart,
      });
    }
    return { operationId, enqueued };
  } catch (error) {
    await transitionProductSyncOp({
      operationId,
      shopUrl,
      from: "QUEUED",
      to: "ENQUEUE_FAILED",
      data: { lastError: error.message || String(error) },
    }).catch(() => {});
    throw error;
  }
}

async function enqueueStoresForSync(stores, reason, now = new Date()) {
  const windowStart = toIsoHourWindowStart(now);
  let enqueuedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const results = await Promise.allSettled(stores.map((store) => (
    seedAndEnqueueProductSyncJob({
      shopUrl: store.shopUrl,
      reason,
      windowStart,
    }).then((result) => ({ store, result }))
  )));

  for (const settled of results) {
    if (settled.status === "rejected") {
      failedCount += 1;
      logger.error("Failed to seed/enqueue product sync execution job", {
        syncReason: reason,
        windowStart,
        message: settled.reason?.message || String(settled.reason),
        stack: settled.reason?.stack,
      });
      continue;
    }
    if (settled.value?.result?.enqueued?.skipped) skippedCount += 1;
    else enqueuedCount += 1;
  }

  return {
    enqueuedCount,
    skippedCount,
    failedCount,
    total: stores.length,
    windowStart,
    reason,
  };
}

async function syncAllStoresBatched({ shopUrl }) {
  const scopedShop = String(shopUrl || "").trim();
  if (!scopedShop) {
    throw new Error("schedule-all-product-syncs requires shopUrl");
  }
  const windowStart = toIsoHourWindowStart();
  const store = await db.store.findUnique({
    where: { shopUrl: scopedShop },
    select: { shopUrl: true, isUnInstalled: true },
  });
  if (!store || store.isUnInstalled) {
    return {
      enqueuedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      total: 1,
      windowStart,
      reason: "scheduled_all_stores",
    };
  }

  const result = await seedAndEnqueueProductSyncJob({
    shopUrl: store.shopUrl,
    reason: "scheduled_all_stores",
    windowStart,
  });
  return {
    enqueuedCount: result?.enqueued?.skipped ? 0 : 1,
    skippedCount: result?.enqueued?.skipped ? 1 : 0,
    failedCount: 0,
    total: 1,
    windowStart,
    reason: "scheduled_all_stores",
  };
}

async function handleAutoSync({ shopUrl }) {
  const scopedShop = String(shopUrl || "").trim();
  if (!scopedShop) {
    throw new Error("auto-sync requires shopUrl");
  }
  const now = new Date();
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const store = await db.store.findUnique({
    where: {
      shopUrl: scopedShop,
    },
    select: {
      shopUrl: true,
      isUnInstalled: true,
      isProductSyncing: true,
      lastProductSyncAt: true,
    },
  });
  const due = store
    && !store.isUnInstalled
    && !store.isProductSyncing
    && (!store.lastProductSyncAt || new Date(store.lastProductSyncAt) < sixHoursAgo);
  return enqueueStoresForSync(due ? [store] : [], "auto_sync", now);
}

async function handlePrioritySync({ shopUrl }) {
  const scopedShop = String(shopUrl || "").trim();
  if (!scopedShop) {
    throw new Error("priority-sync requires shopUrl");
  }
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const store = await db.store.findUnique({
    where: {
      shopUrl: scopedShop,
    },
    select: {
      shopUrl: true,
      isUnInstalled: true,
      isProductSyncing: true,
      lastProductSyncAt: true,
      lastActivityAt: true,
    },
  });
  const due = store
    && !store.isUnInstalled
    && !store.isProductSyncing
    && store.lastProductSyncAt
    && new Date(store.lastProductSyncAt) < twoHoursAgo
    && store.lastActivityAt
    && new Date(store.lastActivityAt) > twoHoursAgo;
  return enqueueStoresForSync(due ? [store] : [], "priority_sync", now);
}

async function syncStore({ shopUrl, syncReason, windowStart, operationId, job }) {
  if (isStaleWindow(windowStart)) {
    return { skipped: true, reason: "stale_product_sync_window", windowStart };
  }

  await job.updateProgress({ stage: "started", percent: 5 });
  await assertShopStillInstalled(shopUrl);
  await job.updateProgress({ stage: "shop_validated", percent: 10 });

  await claimStoreSync(shopUrl);
  const shopLock = await acquireShopLock(shopUrl);
  if (!shopLock?.acquired) {
    await releaseStoreSyncClaim(shopUrl).catch(() => {});
    const error = new Error("PRODUCT_SYNC_LOCK_BUSY");
    error.retryable = true;
    throw error;
  }
  await job.updateProgress({ stage: "lock_acquired", percent: 20 });

  let shopLockHeld = true;
  let heartbeat = null;
  let lockHeartbeatLost = false;
  let submittedToShopify = false;
  try {
    await assertProductSyncNotCancelled({ shopUrl, operationId });

    heartbeat = setInterval(() => {
      void renewRedisLock({
        connection,
        key: shopLock.key,
        token: shopLock.token,
        ttlMs: LOCK_TTL_MS,
      }).catch((error) => {
        lockHeartbeatLost = true;
        logger.error("Product sync lock heartbeat failed", {
          shop: shopUrl,
          message: error.message,
          stack: error.stack,
        });
      });
    }, HEARTBEAT_INTERVAL_MS);

    await enforceShopRateLimit({
      connection,
      shop: shopUrl,
      scope: "product-sync",
      max: 2,
      durationMs: 1000,
    });
    await job.updateProgress({ stage: "rate_limited", percent: 30 });

    const existingOperation = await db.operationFingerprint.findFirst({
      where: {
        id: operationId,
        shop: shopUrl,
        operationType: "PRODUCT_SYNC",
      },
      select: {
        status: true,
        resourceId: true,
      },
    });
    if (
      existingOperation?.status
      && !PRODUCT_SYNC_OPERATION_STATUSES.has(String(existingOperation.status))
    ) {
      throw new Error(`UNKNOWN_PRODUCT_SYNC_OPERATION_STATUS:${existingOperation.status}`);
    }
    switch (existingOperation?.status) {
      case "RUNNING":
        if (existingOperation.resourceId) {
          return {
            skipped: true,
            reason: "shopify_bulk_operation_already_submitted",
            bulkOperationId: existingOperation.resourceId,
          };
        }
        throw new Error("PRODUCT_SYNC_RUNNING_WITHOUT_BULK_OPERATION_ID");
      case "COMPLETED":
      case "CANCELLED":
        return {
          skipped: true,
          reason: `product_sync_already_${String(existingOperation.status).toLowerCase()}`,
        };
      case "FAILED":
        throw new Error("PRODUCT_SYNC_ALREADY_FAILED");
      case "RECONCILE_SUBMITTED":
        return {
          skipped: true,
          reason: "product_sync_requires_reconciliation",
          bulkOperationId: existingOperation.resourceId || null,
        };
      case "ENQUEUE_FAILED": {
        const error = new Error("PRODUCT_SYNC_ENQUEUE_PREVIOUSLY_FAILED");
        error.retryable = true;
        throw error;
      }
      default:
        break;
    }

    const claimed = await transitionProductSyncOp({
      operationId,
      shopUrl,
      from: ["QUEUED", "RETRYABLE_FAILURE"],
      to: "SUBMITTING",
      data: { lastError: null },
    });
    if (claimed.count !== 1) {
      throw new Error("PRODUCT_SYNC_OPERATION_NOT_CLAIMABLE");
    }

    const session = await restoreSession(shopUrl);
    await job.updateProgress({ stage: "session_restored", percent: 45 });

    const currentBulkOperation = await getCurrentBulkOperationStatus(session, "QUERY");
    if (ACTIVE_BULK_OPERATION_STATUSES.has(String(currentBulkOperation?.status || "").toUpperCase())) {
      const error = new Error(
        `SHOPIFY_QUERY_BULK_OPERATION_ACTIVE:${currentBulkOperation.status}`,
      );
      error.retryable = true;
      throw error;
    }
    await job.updateProgress({ stage: "bulk_status_checked", percent: 60 });
    await job.updateProgress({ stage: "pre_submit_checks_passed", percent: 70 });
    if (lockHeartbeatLost) {
      const error = new Error("PRODUCT_SYNC_LOCK_HEARTBEAT_LOST");
      error.retryable = true;
      throw error;
    }

    const service = createProductService();
    const result = await service.startBulkOperationToFetchProducts({
      session,
      isInitialSync: false,
    });
    if (!result?.bulkOperationId) {
      throw new Error("SHOPIFY_BULK_OPERATION_ID_MISSING");
    }
    submittedToShopify = true;
    await job.updateProgress({ stage: "shopify_bulk_started", percent: 90 });

    const running = await transitionProductSyncOp({
      operationId,
      shopUrl,
      from: "SUBMITTING",
      to: "RUNNING",
      data: {
        resourceType: "shopify_bulk_operation",
        resourceId: String(result.bulkOperationId),
        lastProductSyncSubmittedAt: new Date(),
        lastError: null,
      },
    });
    if (running.count !== 1) {
      await transitionProductSyncOp({
        operationId,
        shopUrl,
        from: "SUBMITTING",
        to: "RECONCILE_SUBMITTED",
        data: {
          resourceType: "shopify_bulk_operation",
          resourceId: String(result.bulkOperationId),
          lastProductSyncSubmittedAt: new Date(),
          lastError: "RUNNING transition failed after Shopify accepted bulk operation",
        },
      }).catch(() => {});

      throw Object.assign(
        new Error("PRODUCT_SYNC_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE"),
        { retryable: false },
      );
    }
    await job.updateProgress({ stage: "running_persisted", percent: 100 });

    return {
      success: true,
      shopUrl,
      operationId,
      syncReason,
      bulkOperationId: result.bulkOperationId,
      syncHistoryId: result.syncHistoryId || null,
    };
  } catch (error) {
    if (error.message === "PRODUCT_SYNC_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE") {
      throw error;
    }

    const retryState =
      error.retryable && !willExhaustRetryFromProcessor(job)
        ? "RETRYABLE_FAILURE"
        : "FAILED";
    await transitionProductSyncOp({
      operationId,
      shopUrl,
      from: ["SUBMITTING", "RUNNING", "QUEUED", "RETRYABLE_FAILURE"],
      to: retryState,
      data: { lastError: error.message || String(error) },
    }).catch(() => {});
    if (isNonRetryableProductSyncError(error)) {
      await job.discard();
    }
    logger.error("Product sync store failed", {
      worker: "productSyncExecuteWorker",
      shop: shopUrl,
      operationId,
      message: error.message,
      stack: error.stack,
    });
    throw error;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (shopLockHeld) {
      await releaseShopLock(shopLock);
      shopLockHeld = false;
    }
    if (!submittedToShopify) {
      await releaseStoreSyncClaim(shopUrl).catch(() => {});
    }
  }
}

const schedulerProcessor = async (job) => {
  if (!PRODUCT_SYNC_JOB_NAMES.has(job.name)) {
    throw new Error(`UNSUPPORTED_PRODUCT_SYNC_JOB_NAME:${job.name}`);
  }
  switch (job.name) {
    case "schedule-all-product-syncs":
      return syncAllStoresBatched({ shopUrl: job.data?.shopUrl || job.data?.shop });
    case "auto-sync":
      return handleAutoSync({ shopUrl: job.data?.shopUrl || job.data?.shop });
    case "priority-sync":
      return handlePrioritySync({ shopUrl: job.data?.shopUrl || job.data?.shop });
    default:
      throw new Error(`UNSUPPORTED_PRODUCT_SYNC_SCHEDULER_JOB:${job.name}`);
  }
};

const executeProcessor = async (job) => {
  if (!PRODUCT_SYNC_JOB_NAMES.has(job.name)) {
    throw new Error(`UNSUPPORTED_PRODUCT_SYNC_JOB_NAME:${job.name}`);
  }
  switch (job.name) {
    case "store-product-sync":
    case "manual-product-sync":
      return syncStore({
        shopUrl: job.data.shopUrl,
        syncReason: job.data.syncReason || "manual",
        windowStart: job.data.windowStart,
        operationId: job.data.operationId,
        job,
      });
    default:
      throw new Error(`UNSUPPORTED_PRODUCT_SYNC_EXECUTE_JOB:${job.name}`);
  }
};

export const productSyncSchedulerWorker = new Worker(
  PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
  schedulerProcessor,
  {
    connection,
    concurrency: 1,
    lockDuration: Number(process.env.PRODUCT_SYNC_SCHEDULER_LOCK_DURATION_MS || 300000),
    stalledInterval: Number(process.env.PRODUCT_SYNC_SCHEDULER_STALLED_INTERVAL_MS || 60000),
    maxStalledCount: Number(process.env.PRODUCT_SYNC_SCHEDULER_MAX_STALLED_COUNT || 1),
  },
);

export const productSyncWorker = new Worker(
  PRODUCT_SYNC_QUEUE_NAME,
  executeProcessor,
  {
    connection,
    concurrency: Number(process.env.PRODUCT_SYNC_CONCURRENCY || 3),
    limiter: {
      max: Number(process.env.PRODUCT_SYNC_LIMIT_MAX || 10),
      duration: Number(process.env.PRODUCT_SYNC_LIMIT_DURATION_MS || 60000),
    },
    lockDuration: Number(process.env.PRODUCT_SYNC_LOCK_DURATION_MS || 600000),
    stalledInterval: Number(process.env.PRODUCT_SYNC_STALLED_INTERVAL_MS || 60000),
    maxStalledCount: Number(process.env.PRODUCT_SYNC_MAX_STALLED_COUNT || 1),
  },
);

const productSyncQueueEvents = new QueueEvents(PRODUCT_SYNC_QUEUE_NAME, {
  connection: createRedisConnection(),
});
const productSyncSchedulerQueueEvents = new QueueEvents(PRODUCT_SYNC_SCHEDULER_QUEUE_NAME, {
  connection: createRedisConnection(),
});

productSyncQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Product sync queue event failed", {
    queue: PRODUCT_SYNC_QUEUE_NAME,
    jobId,
    failedReason,
  });
});

productSyncQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Product sync queue event stalled", {
    queue: PRODUCT_SYNC_QUEUE_NAME,
    jobId,
  });
});

productSyncSchedulerQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Product sync scheduler queue event failed", {
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    jobId,
    failedReason,
  });
});

productSyncSchedulerQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Product sync scheduler queue event stalled", {
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    jobId,
  });
});

productSyncWorker.on("completed", (job, result) => {
  logger.info("Product sync execute worker completed", {
    worker: "productSyncExecuteWorker",
    queue: PRODUCT_SYNC_QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shopUrl,
    operationId: job?.data?.operationId,
    success: Boolean(result?.success),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

productSyncWorker.on("failed", (job, err) => {
  if (hasExhaustedRetryFromFailedEvent(job)) {
    void productSyncDlqQueue.add(
      "product-sync-dlq",
      {
        originalQueue: PRODUCT_SYNC_QUEUE_NAME,
        originalJobId: job?.id,
        originalJobName: job?.name,
        data: job?.data,
        failedReason: err?.message,
        stack: err?.stack,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq:${PRODUCT_SYNC_QUEUE_NAME}:${job?.id}`,
        removeOnComplete: { age: 604800, count: 5000 },
      },
    ).catch((dlqErr) => {
      logger.error("Product sync DLQ enqueue failed", {
        worker: "productSyncExecuteWorker",
        queue: PRODUCT_SYNC_DLQ_QUEUE_NAME,
        originalJobId: job?.id,
        message: dlqErr?.message,
        stack: dlqErr?.stack,
      });
    });
  }

  logger.error("Product sync execute worker failed", {
    worker: "productSyncExecuteWorker",
    queue: PRODUCT_SYNC_QUEUE_NAME,
    jobId: job?.id,
    jobName: job?.name,
    shop: job?.data?.shopUrl,
    operationId: job?.data?.operationId,
    attemptsMade: job?.attemptsMade,
    maxAttempts: getMaxAttempts(job),
    retryable: Boolean(err?.retryable),
    message: err?.message,
    stack: err?.stack,
    data: job?.data,
  });
});

productSyncWorker.on("error", (err) => {
  logger.error("Product sync execute worker error", {
    worker: "productSyncExecuteWorker",
    queue: PRODUCT_SYNC_QUEUE_NAME,
    message: err?.message,
    stack: err?.stack,
  });
});

productSyncWorker.on("stalled", (jobId) => {
  logger.warn("Product sync execute worker stalled", {
    worker: "productSyncExecuteWorker",
    queue: PRODUCT_SYNC_QUEUE_NAME,
    jobId,
  });
});

productSyncSchedulerWorker.on("failed", (job, err) => {
  logger.error("Product sync scheduler worker failed", {
    worker: "productSyncSchedulerWorker",
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    jobId: job?.id,
    jobName: job?.name,
    message: err?.message,
    stack: err?.stack,
  });
});

productSyncSchedulerWorker.on("error", (err) => {
  logger.error("Product sync scheduler worker error", {
    worker: "productSyncSchedulerWorker",
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    message: err?.message,
    stack: err?.stack,
  });
});

productSyncSchedulerWorker.on("stalled", (jobId) => {
  logger.warn("Product sync scheduler worker stalled", {
    worker: "productSyncSchedulerWorker",
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    jobId,
  });
});
productSyncSchedulerWorker.on("completed", (job) => {
  logger.info("Product sync scheduler worker completed", {
    worker: "productSyncSchedulerWorker",
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    jobId: job?.id,
    jobName: job?.name,
  });
});

async function recoverStaleProductSyncFlags() {
  const cutoff = new Date(Date.now() - PRODUCT_SYNC_STALE_MS);
  await db.store.updateMany({
    where: {
      OR: [
        {
          isProductSyncing: true,
          productSyncStartedAt: { lt: cutoff },
        },
        {
          isProductInitialySyning: true,
          updatedAt: { lt: cutoff },
        },
        {
          syncProgressStage: { in: ["SHOPIFY_BULK_RUNNING", "MIRROR_STAGING"] },
          updatedAt: { lt: cutoff },
        },
      ],
    },
    data: {
      isProductSyncing: false,
      isProductInitialySyning: false,
      syncProgressStage: "IDLE",
      shopifyBulkJobCompleted: true,
      productSyncRecoveryRequired: true,
      productSyncStartedAt: null,
      lastSyncErrorSummary: "Product sync timed out before completion. Please start sync again.",
      updatedAt: new Date(),
    },
  });
}

async function runBootRecovery() {
  const recoveryLock = await acquireRedisLock({
    connection,
    key: "lock:product_sync:stale_recovery",
    ttlMs: 5 * 60 * 1000,
  });
  if (!recoveryLock?.acquired) return;

  try {
    await recoverStaleProductSyncFlags();
  } catch (error) {
    logger.error("Product sync stale flag recovery failed", {
      message: error.message,
      stack: error.stack,
    });
  } finally {
    await releaseRedisLock({
      connection,
      key: recoveryLock.key,
      token: recoveryLock.token,
    }).catch(() => {});
  }
}

void runBootRecovery().catch((error) => {
  logger.error("Boot recovery failed non-fatally", {
    message: error.message,
    stack: error.stack,
  });
});

logger.info("Product sync worker booted", {
  executeQueue: PRODUCT_SYNC_QUEUE_NAME,
  schedulerQueue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
  executeConcurrency: Number(process.env.PRODUCT_SYNC_CONCURRENCY || 3),
  schedulerConcurrency: 1,
  limiterMax: Number(process.env.PRODUCT_SYNC_LIMIT_MAX || 10),
  limiterDurationMs: Number(process.env.PRODUCT_SYNC_LIMIT_DURATION_MS || 60000),
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("PRODUCT_SYNC_WORKER_CLOSE_TIMEOUT")), 25_000));

  try {
    await Promise.race([
      (async () => {
        await productSyncWorker.close();
        await productSyncSchedulerWorker.close();
        await productSyncQueueEvents.close();
        await productSyncSchedulerQueueEvents.close();
      })(),
      timeout,
    ]);
  } catch (error) {
    logger.error("Product sync worker shutdown failed", {
      signal,
      message: error.message,
      stack: error.stack,
    });
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default productSyncWorker;
