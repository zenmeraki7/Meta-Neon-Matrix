// web/Jobs/Workers/productSyncWorker.js

import crypto from "crypto";
import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { startBulkOperationToFetchProducts } from "../../services/productService/productSyncService.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { seedProductSyncOperation } from "../Queues/productSyncQueue.js";
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
import { normalizeShopDomain } from "../../utils/shopDomainUtils.js";
import { SYNC_OPERATION_TYPE, SYNC_STATUS_NORMALIZED } from "../../constants/syncConstants.js";

function readBoundedIntegerEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

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
  "RECONCILE_SUBMITTED",
  "COMPLETED",
  "CANCELLED",
  "CANCEL_REQUESTED",
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  QUEUED: new Set(["SUBMITTING", "CANCELLED", "FAILED"]),
  RETRYABLE_FAILURE: new Set(["SUBMITTING", "CANCELLED", "FAILED"]),
  SUBMITTING: new Set(["RUNNING", "RETRYABLE_FAILURE", "FAILED", "RECONCILE_SUBMITTED", "CANCELLED"]),
  RUNNING: new Set(["COMPLETED", "FAILED", "RECONCILE_SUBMITTED", "CANCELLED"]),
  RECONCILE_SUBMITTED: new Set(["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
});

const ALLOWED_SYNC_REASONS = new Set([
  "SCHEDULED",
  "MANUAL",
  "PRIORITY",
  "AUTO_SYNC",
  "STORE_PRODUCT_SYNC",
  "INITIAL_SYNC",
  "RECOVERY",
  "SCHEDULED_ALL_STORES",
  "AUTO_SYNC",
  "PRIORITY_SYNC",
]);

const ALLOWED_EXECUTION_JOB_DATA_KEYS = new Set([
  "shopUrl",
  "syncReason",
  "windowStart",
  "operationId",
  "idempotencyKey",
]);

const ACTIVE_BULK_OPERATION_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);
const HEARTBEAT_INTERVAL_MS = 60_000;
const LOCK_TTL_MS = readBoundedIntegerEnv("PRODUCT_SYNC_LOCK_TTL_MS", 600_000, { min: 60_000, max: 3_600_000 });
const PRODUCT_SYNC_STALE_MS = readBoundedIntegerEnv("PRODUCT_SYNC_STALE_MS", 7_200_000, { min: 300_000, max: 86_400_000 });

const AUTO_SYNC_BATCH_SIZE = readBoundedIntegerEnv("AUTO_SYNC_BATCH_SIZE", 10, { min: 1, max: 100 });
const PRIORITY_SYNC_BATCH_SIZE = readBoundedIntegerEnv("PRIORITY_SYNC_BATCH_SIZE", 5, { min: 1, max: 50 });
const ALL_STORES_SYNC_BATCH_SIZE = readBoundedIntegerEnv("ALL_STORES_SYNC_BATCH_SIZE", 20, { min: 1, max: 100 });
const ALL_STORES_SYNC_BATCH_DELAY_MS = readBoundedIntegerEnv("ALL_STORES_SYNC_BATCH_DELAY_MS", 50, { min: 0, max: 5_000 });

function buildDeterministicOperationId({ shopUrl, reason, windowStart, idempotencyKey }) {
  const payload = JSON.stringify({
    shop: String(shopUrl || "").toLowerCase(),
    reason: String(reason || "").toUpperCase(),
    key: String(idempotencyKey || windowStart || ""),
  });
  const hash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
  return `product-sync-op:${hash}`;
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

function normalizeProductSyncErrorCode(error) {
  if (error?.code && typeof error.code === "string") {
    return error.code;
  }
  const msg = String(error?.message || "");
  if (msg.includes("OFFLINE_SESSION_NOT_FOUND")) return "OFFLINE_SESSION_NOT_FOUND";
  if (msg.includes("SHOP_UNINSTALLED")) return "SHOP_UNINSTALLED";
  if (msg.includes("CANCELLED")) return "CANCELLED";
  if (msg.includes("ALREADY_RUNNING")) return "ALREADY_RUNNING";
  if (msg.includes("LOCK_LOST")) return "LOCK_LOST";
  return "PRODUCT_SYNC_FAILED";
}

function getSafeProductSyncErrorSummary(error) {
  const code = normalizeProductSyncErrorCode(error);
  switch (code) {
    case "OFFLINE_SESSION_NOT_FOUND":
      return "Offline session token was not found for this shop.";
    case "SHOP_UNINSTALLED":
      return "Shop is uninstalled or inactive.";
    case "CANCELLED":
      return "Product sync operation was cancelled.";
    case "ALREADY_RUNNING":
      return "Product sync is already running for this shop.";
    case "LOCK_LOST":
      return "Worker lost lock token prior to completing operation.";
    case "PRODUCT_SYNC_OPERATION_NOT_FOUND":
      return "Product sync operation was not found.";
    default:
      return "Product synchronization failed.";
  }
}

function isNonRetryableProductSyncError(error) {
  return Boolean(error?.nonRetryable) || [
    "OFFLINE_SESSION_NOT_FOUND",
    "SHOP_UNINSTALLED",
    "PRODUCT_SYNC_CANCELLED_BEFORE_SUBMIT",
    "INVALID_JOB_DATA",
    "INVALID_SHOP_DOMAIN",
    "INVALID_SYNC_REASON",
    "PRODUCT_SYNC_OPERATION_NOT_FOUND",
    "UNSUPPORTED_JOB_NAME",
  ].includes(error?.code || error?.message);
}

function normalizeProductSyncJobData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("Invalid job data payload");
    error.code = "INVALID_JOB_DATA";
    error.nonRetryable = true;
    throw error;
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_EXECUTION_JOB_DATA_KEYS.has(key)) {
      const error = new Error(`Invalid job data key: ${key}`);
      error.code = "INVALID_JOB_DATA_KEY";
      error.nonRetryable = true;
      throw error;
    }
  }

  const shopUrl = normalizeShopDomain(data.shopUrl);
  if (!shopUrl) {
    const error = new Error("Invalid shop domain");
    error.code = "INVALID_SHOP_DOMAIN";
    error.nonRetryable = true;
    throw error;
  }

  const rawReason = String(data.syncReason || "MANUAL").toUpperCase();
  if (!ALLOWED_SYNC_REASONS.has(rawReason)) {
    const error = new Error("Invalid sync reason");
    error.code = "INVALID_SYNC_REASON";
    error.nonRetryable = true;
    throw error;
  }

  const operationId = data.operationId ? String(data.operationId).trim() : null;

  const windowStart = data.windowStart ? String(data.windowStart).trim() : null;
  if (windowStart && isNaN(Date.parse(windowStart))) {
    const error = new Error("Invalid windowStart date");
    error.code = "INVALID_WINDOW_START";
    error.nonRetryable = true;
    throw error;
  }

  return {
    shopUrl,
    syncReason: rawReason,
    windowStart,
    operationId,
    idempotencyKey: data.idempotencyKey ? String(data.idempotencyKey).trim() : null,
  };
}

async function acquireShopLock(shopUrl, ttlMs = LOCK_TTL_MS) {
  const hash = crypto.createHash("sha256").update(String(shopUrl).toLowerCase()).digest("hex").slice(0, 16);
  const key = `lock:product_sync:${hash}`;
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
      installationStatus: true,
    },
  });
  if (!store || store.installationStatus !== "INSTALLED") {
    const error = new Error("Shop is uninstalled or inactive");
    error.code = "SHOP_UNINSTALLED";
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
    const error = new Error("Product sync operation was cancelled before submit");
    error.code = "CANCELLED";
    error.nonRetryable = true;
    throw error;
  }
}

async function claimStoreSync(shopUrl) {
  const claimed = await db.store.updateMany({
    where: {
      shopUrl,
      installationStatus: "INSTALLED",
      OR: [
        { isProductSyncing: false },
        { currentProductMirrorBatchId: null },
      ],
    },
    data: {
      isProductSyncing: true,
      productSyncStartedAt: new Date(),
      requiresProductSyncRecovery: false,
      lastProductSyncAttemptAt: new Date(),
      updatedAt: new Date(),
    },
  });
  if (claimed.count !== 1) {
    const error = new Error("Product sync is already running for this shop");
    error.code = "ALREADY_RUNNING";
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

async function updateOperationDatabaseHeartbeat({ operationId, shopUrl }) {
  if (!operationId) return;
  await db.operationFingerprint.updateMany({
    where: {
      id: operationId,
      shop: shopUrl,
      operationType: "PRODUCT_SYNC",
      status: { in: ["SUBMITTING", "RUNNING"] },
    },
    data: {
      updatedAt: new Date(),
    },
  }).catch(() => {});
}

function getMaxAttempts(job) {
  return Number(job?.opts?.attempts || 1);
}

function hasExhaustedRetryFromFailedEvent(job) {
  return Number(job?.attemptsMade || 0) >= getMaxAttempts(job);
}

function willExhaustRetryFromProcessor(job) {
  return Number(job?.attemptsMade || 0) + 1 >= getMaxAttempts(job);
}

async function restoreSession(shop) {
  const sessionId = `offline_${shop}`;
  const session = await shopify.config.sessionStorage.loadSession(sessionId);
  if (!session?.accessToken) {
    const error = new Error("Offline session token was not found for this shop");
    error.code = "OFFLINE_SESSION_NOT_FOUND";
    error.nonRetryable = true;
    throw error;
  }
  return session;
}

async function transitionProductSyncOp({
  operationId,
  shopUrl,
  from,
  to,
  data = {},
}) {
  if (!PRODUCT_SYNC_OPERATION_STATUSES.has(String(to))) {
    const error = new Error(`Invalid destination status: ${to}`);
    error.code = "INVALID_DESTINATION_STATUS";
    throw error;
  }

  const fromList = Array.isArray(from) ? from : [from];
  for (const srcState of fromList) {
    const allowedTargets = ALLOWED_TRANSITIONS[srcState];
    if (allowedTargets && !allowedTargets.has(String(to))) {
      const error = new Error(`Disallowed transition edge: ${srcState} -> ${to}`);
      error.code = "INVALID_TRANSITION_EDGE";
      throw error;
    }
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
  });

  return { operationId };
}

async function enqueueStoresForSync(stores, reason, now = new Date()) {
  const windowStart = toIsoHourWindowStart(now);
  let enqueuedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const CONCURRENCY_CHUNK_SIZE = 5;
  for (let i = 0; i < stores.length; i += CONCURRENCY_CHUNK_SIZE) {
    const chunk = stores.slice(i, i + CONCURRENCY_CHUNK_SIZE);
    const results = await Promise.allSettled(
      chunk.map((store) =>
        seedAndEnqueueProductSyncJob({
          shopUrl: store.shopUrl,
          reason,
          windowStart,
        }),
      ),
    );

    for (const settled of results) {
      if (settled.status === "rejected") {
        failedCount += 1;
        logger.error("Failed to seed product sync operation", {
          syncReason: reason,
          windowStart,
          errorCode: normalizeProductSyncErrorCode(settled.reason),
        });
        continue;
      }
      enqueuedCount += 1;
    }
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

async function syncAllStoresBatched() {
  const batchSize = ALL_STORES_SYNC_BATCH_SIZE;
  const windowStart = toIsoHourWindowStart();
  let lastId = null;

  let enqueuedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let total = 0;

  while (true) {
    const stores = await db.store.findMany({
      where: {
        installationStatus: "INSTALLED",
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      select: { id: true, shopUrl: true },
      orderBy: { id: "asc" },
      take: batchSize,
    });

    if (stores.length === 0) break;
    total += stores.length;

    const CONCURRENCY_CHUNK_SIZE = 5;
    for (let i = 0; i < stores.length; i += CONCURRENCY_CHUNK_SIZE) {
      const chunk = stores.slice(i, i + CONCURRENCY_CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map((store) =>
          seedAndEnqueueProductSyncJob({
            shopUrl: store.shopUrl,
            reason: "scheduled_all_stores",
            windowStart,
          }),
        ),
      );

      for (const settled of results) {
        if (settled.status === "rejected") {
          failedCount += 1;
          logger.error("Failed to seed product sync operation", {
            syncReason: "scheduled_all_stores",
            windowStart,
            errorCode: normalizeProductSyncErrorCode(settled.reason),
          });
          continue;
        }
        enqueuedCount += 1;
      }
    }

    lastId = stores[stores.length - 1].id;
    if (ALL_STORES_SYNC_BATCH_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, ALL_STORES_SYNC_BATCH_DELAY_MS));
    }
  }

  return {
    enqueuedCount,
    skippedCount,
    failedCount,
    total,
    windowStart,
    reason: "scheduled_all_stores",
  };
}

async function handleAutoSync() {
  const now = new Date();
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const storesToSync = await db.store.findMany({
    where: {
      installationStatus: "INSTALLED",
      isProductSyncing: false,
      OR: [
        { lastProductSyncAt: { lt: sixHoursAgo } },
        { lastProductSyncAt: null },
      ],
    },
    select: { shopUrl: true },
    orderBy: { lastProductSyncAt: "asc" },
    take: AUTO_SYNC_BATCH_SIZE,
  });
  return enqueueStoresForSync(storesToSync, "auto_sync", now);
}

// Item 45: Add deterministic ordering to priority sync
async function handlePrioritySync() {
  const now = new Date();
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const activeStores = await db.store.findMany({
    where: {
      installationStatus: "INSTALLED",
      isProductSyncing: false,
      lastProductSyncAt: { lt: twoHoursAgo },
      lastActivityAt: { gt: twoHoursAgo },
    },
    select: { shopUrl: true },
    orderBy: [
      { lastActivityAt: "desc" },
      { id: "asc" },
    ],
    take: PRIORITY_SYNC_BATCH_SIZE,
  });
  return enqueueStoresForSync(activeStores, "priority_sync", now);
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
    const error = new Error("Product sync lock busy");
    error.code = "PRODUCT_SYNC_LOCK_BUSY";
    error.retryable = true;
    throw error;
  }
  await job.updateProgress({ stage: "lock_acquired", percent: 20 });

  let shopLockHeld = true;
  let heartbeat = null;
  let lockHeartbeatLost = false;
  let submittedToShopify = false;
  const abortController = new AbortController();

  try {
    await assertProductSyncNotCancelled({ shopUrl, operationId });

    heartbeat = setInterval(() => {
      void renewRedisLock({
        connection,
        key: shopLock.key,
        token: shopLock.token,
        ttlMs: LOCK_TTL_MS,
      }).then((renewed) => {
        if (!renewed?.acquired) {
          lockHeartbeatLost = true;
          abortController.abort("LOCK_LOST");
        } else {
          void updateOperationDatabaseHeartbeat({ operationId, shopUrl });
        }
      }).catch((error) => {
        lockHeartbeatLost = true;
        abortController.abort("LOCK_LOST");
        logger.error("Product sync lock heartbeat failed", {
          shop: shopUrl,
          errorCode: normalizeProductSyncErrorCode(error),
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

    // Item 50: Reload operation state from authoritative server database row
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

    if (!existingOperation) {
      const error = new Error("Product sync operation was not found");
      error.code = "PRODUCT_SYNC_OPERATION_NOT_FOUND";
      error.nonRetryable = true;
      throw error;
    }

    if (
      existingOperation?.status &&
      !PRODUCT_SYNC_OPERATION_STATUSES.has(String(existingOperation.status))
    ) {
      const error = new Error(`Unknown operation status: ${existingOperation.status}`);
      error.code = "UNKNOWN_OPERATION_STATUS";
      throw error;
    }

    switch (existingOperation.status) {
      case "RUNNING":
        if (existingOperation.resourceId) {
          return {
            skipped: true,
            reason: "shopify_bulk_operation_already_submitted",
            shopifyBulkOperationId: existingOperation.resourceId,
          };
        }
        throw new Error("Product sync running without bulk operation ID");
      case "COMPLETED":
      case "CANCELLED":
        return {
          skipped: true,
          reason: `product_sync_already_${String(existingOperation.status).toLowerCase()}`,
        };
      case "FAILED":
        throw new Error("Product sync already failed");
      case "RECONCILE_SUBMITTED":
        return {
          skipped: true,
          reason: "product_sync_requires_reconciliation",
          shopifyBulkOperationId: existingOperation.resourceId || null,
        };
      default:
        break;
    }

    const claimed = await transitionProductSyncOp({
      operationId,
      shopUrl,
      from: ["QUEUED", "RETRYABLE_FAILURE"],
      to: "SUBMITTING",
      data: {
        lastErrorCode: null,
        lastErrorSummary: null,
      },
    });

    if (claimed.count !== 1) {
      const error = new Error("Product sync operation not claimable");
      error.code = "OPERATION_NOT_CLAIMABLE";
      throw error;
    }

    const session = await restoreSession(shopUrl);
    await job.updateProgress({ stage: "session_restored", percent: 45 });

    const currentBulkOperation = await getCurrentBulkOperationStatus(session, "QUERY");
    if (ACTIVE_BULK_OPERATION_STATUSES.has(String(currentBulkOperation?.status || "").toUpperCase())) {
      const error = new Error(`Shopify bulk operation active: ${currentBulkOperation.status}`);
      error.code = "SHOPIFY_BULK_OPERATION_ACTIVE";
      error.retryable = true;
      throw error;
    }
    await job.updateProgress({ stage: "bulk_status_checked", percent: 60 });
    await job.updateProgress({ stage: "pre_submit_checks_passed", percent: 70 });

    if (lockHeartbeatLost || abortController.signal.aborted) {
      const error = new Error("Product sync lock heartbeat lost prior to submit");
      error.code = "LOCK_LOST";
      error.retryable = true;
      throw error;
    }

    await assertProductSyncNotCancelled({ shopUrl, operationId });

    const preSubmitLock = await renewRedisLock({
      connection,
      key: shopLock.key,
      token: shopLock.token,
      ttlMs: LOCK_TTL_MS,
    });
    if (!preSubmitLock?.acquired || abortController.signal.aborted) {
      const error = new Error("Product sync lock lost prior to Shopify submission");
      error.code = "LOCK_LOST_BEFORE_SUBMIT";
      error.retryable = true;
      throw error;
    }

    const result = await startBulkOperationToFetchProducts({
      session,
      isInitialSync: false,
    });

    if (!result?.shopifyBulkOperationId) {
      const error = new Error("Shopify bulk operation ID missing");
      error.code = "SHOPIFY_BULK_OPERATION_ID_MISSING";
      throw error;
    }
    submittedToShopify = true;
    await job.updateProgress({ stage: "shopify_bulk_started", percent: 90 });

    await db.store.updateMany({
      where: { shopUrl },
      data: {
        isProductSyncing: true,
        productSyncStartedAt: new Date(),
        syncProgressStage: "SHOPIFY_BULK_RUNNING",
        hasCompletedShopifyBulkJob: false,
        updatedAt: new Date(),
      },
    });

    const running = await transitionProductSyncOp({
      operationId,
      shopUrl,
      from: "SUBMITTING",
      to: "RUNNING",
      data: {
        fingerprintResourceType: "shopify_bulk_operation",
        resourceId: String(result.shopifyBulkOperationId),
        lastProductSyncSubmittedAt: new Date(),
        lastErrorCode: null,
        lastErrorSummary: null,
      },
    });

    if (running.count !== 1) {
      await transitionProductSyncOp({
        operationId,
        shopUrl,
        from: "SUBMITTING",
        to: "RECONCILE_SUBMITTED",
        data: {
          fingerprintResourceType: "shopify_bulk_operation",
          resourceId: String(result.shopifyBulkOperationId),
          lastProductSyncSubmittedAt: new Date(),
          lastErrorCode: "TRANSITION_FAILED_AFTER_SHOPIFY_ACCEPT",
          lastErrorSummary: "RUNNING transition failed after Shopify accepted bulk operation.",
        },
      }).catch(() => {});

      const error = new Error("Product sync reconcile submitted after transition failure");
      error.code = "RECONCILE_SUBMITTED_AFTER_FAILURE";
      error.nonRetryable = true;
      throw error;
    }
    await job.updateProgress({ stage: "running_persisted", percent: 100 });

    return {
      success: true,
      shopUrl,
      operationId,
      syncReason,
    };
  } catch (error) {
    if (error.code === "RECONCILE_SUBMITTED_AFTER_FAILURE") {
      throw error;
    }

    const errorCode = normalizeProductSyncErrorCode(error);
    const errorSummary = getSafeProductSyncErrorSummary(error);

    if (submittedToShopify) {
      await transitionProductSyncOp({
        operationId,
        shopUrl,
        from: ["SUBMITTING", "RUNNING"],
        to: "RECONCILE_SUBMITTED",
        data: {
          lastErrorCode: errorCode,
          lastErrorSummary: errorSummary,
        },
      }).catch(() => {});
    } else {
      const retryState =
        error.retryable && !willExhaustRetryFromProcessor(job)
          ? "RETRYABLE_FAILURE"
          : "FAILED";

      await transitionProductSyncOp({
        operationId,
        shopUrl,
        from: ["SUBMITTING", "QUEUED", "RETRYABLE_FAILURE"],
        to: retryState,
        data: {
          lastErrorCode: errorCode,
          lastErrorSummary: errorSummary,
        },
      }).catch(() => {});
    }

    if (isNonRetryableProductSyncError(error)) {
      await job.discard();
    }

    logger.error("Product sync store failed", {
      worker: "productSyncExecuteWorker",
      shop: shopUrl,
      operationId,
      attemptsMade: job?.attemptsMade || 0,
      errorCode,
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

// Item 41: Discard unsupported job names and mark nonRetryable
const schedulerProcessor = async (job) => {
  if (!PRODUCT_SYNC_JOB_NAMES.has(job.name)) {
    await job.discard().catch(() => {});
    const error = new Error(`Unsupported job name: ${job.name}`);
    error.code = "UNSUPPORTED_JOB_NAME";
    error.nonRetryable = true;
    throw error;
  }
  switch (job.name) {
    case "schedule-all-product-syncs":
      return syncAllStoresBatched();
    case "auto-sync":
      return handleAutoSync();
    case "priority-sync":
      return handlePrioritySync();
    default:
      await job.discard().catch(() => {});
      const error = new Error(`Unsupported scheduler job: ${job.name}`);
      error.code = "UNSUPPORTED_JOB_NAME";
      error.nonRetryable = true;
      throw error;
  }
};

const executeProcessor = async (job) => {
  if (!PRODUCT_SYNC_JOB_NAMES.has(job.name)) {
    await job.discard().catch(() => {});
    const error = new Error(`Unsupported job name: ${job.name}`);
    error.code = "UNSUPPORTED_JOB_NAME";
    error.nonRetryable = true;
    throw error;
  }

  const normalizedData = normalizeProductSyncJobData(job.data);

  switch (job.name) {
    case "store-product-sync":
    case "manual-product-sync":
      return syncStore({
        shopUrl: normalizedData.shopUrl,
        syncReason: normalizedData.syncReason,
        windowStart: normalizedData.windowStart,
        operationId: normalizedData.operationId,
        job,
      });
    default:
      await job.discard().catch(() => {});
      const error = new Error(`Unsupported execution job: ${job.name}`);
      error.code = "UNSUPPORTED_JOB_NAME";
      error.nonRetryable = true;
      throw error;
  }
};

export const productSyncSchedulerWorker = new Worker(
  PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
  schedulerProcessor,
  {
    connection,
    concurrency: 1,
    lockDuration: readBoundedIntegerEnv("PRODUCT_SYNC_SCHEDULER_LOCK_DURATION_MS", 300_000, { min: 60_000, max: 3_600_000 }),
    stalledInterval: readBoundedIntegerEnv("PRODUCT_SYNC_SCHEDULER_STALLED_INTERVAL_MS", 60_000, { min: 10_000, max: 600_000 }),
    maxStalledCount: readBoundedIntegerEnv("PRODUCT_SYNC_SCHEDULER_MAX_STALLED_COUNT", 1, { min: 1, max: 5 }),
  },
);

export const productSyncWorker = new Worker(
  PRODUCT_SYNC_QUEUE_NAME,
  executeProcessor,
  {
    connection,
    concurrency: readBoundedIntegerEnv("PRODUCT_SYNC_CONCURRENCY", 3, { min: 1, max: 20 }),
    limiter: {
      max: readBoundedIntegerEnv("PRODUCT_SYNC_LIMIT_MAX", 10, { min: 1, max: 100 }),
      duration: readBoundedIntegerEnv("PRODUCT_SYNC_LIMIT_DURATION_MS", 60_000, { min: 1_000, max: 600_000 }),
    },
    lockDuration: readBoundedIntegerEnv("PRODUCT_SYNC_LOCK_DURATION_MS", 600_000, { min: 60_000, max: 3_600_000 }),
    stalledInterval: readBoundedIntegerEnv("PRODUCT_SYNC_STALLED_INTERVAL_MS", 60_000, { min: 10_000, max: 600_000 }),
    maxStalledCount: readBoundedIntegerEnv("PRODUCT_SYNC_MAX_STALLED_COUNT", 1, { min: 1, max: 5 }),
  },
);

const productSyncQueueEvents = new QueueEvents(PRODUCT_SYNC_QUEUE_NAME, {
  connection: createRedisConnection(),
});
const productSyncSchedulerQueueEvents = new QueueEvents(PRODUCT_SYNC_SCHEDULER_QUEUE_NAME, {
  connection: createRedisConnection(),
});

productSyncQueueEvents.on("error", (err) => {
  logger.error("Product sync queue events connection error", {
    queue: PRODUCT_SYNC_QUEUE_NAME,
    errorCode: normalizeProductSyncErrorCode(err),
  });
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

productSyncSchedulerQueueEvents.on("error", (err) => {
  logger.error("Product sync scheduler queue events connection error", {
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    errorCode: normalizeProductSyncErrorCode(err),
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

// Item 44: Ignore duplicate job ID errors on DLQ insertion silently
productSyncWorker.on("failed", (job, err) => {
  const errorCode = normalizeProductSyncErrorCode(err);

  if (hasExhaustedRetryFromFailedEvent(job)) {
    void productSyncDlqQueue.add(
      "product-sync-dlq",
      {
        originalQueue: PRODUCT_SYNC_QUEUE_NAME,
        originalJobId: job?.id || null,
        originalJobName: job?.name || null,
        shop: job?.data?.shopUrl || null,
        operationId: job?.data?.operationId || null,
        errorCode,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq:${PRODUCT_SYNC_QUEUE_NAME}:${job?.id}`,
        removeOnComplete: { age: 604800, count: 5000 },
      },
    ).catch((dlqErr) => {
      if (!String(dlqErr?.message || "").includes("Job already exists")) {
        logger.error("Product sync DLQ enqueue failed", {
          worker: "productSyncExecuteWorker",
          queue: PRODUCT_SYNC_DLQ_QUEUE_NAME,
          originalJobId: job?.id,
          errorCode: normalizeProductSyncErrorCode(dlqErr),
        });
      }
    });
  }

  logger.error("Product sync execute worker failed", {
    worker: "productSyncExecuteWorker",
    queue: PRODUCT_SYNC_QUEUE_NAME,
    jobId: job?.id,
    jobName: job?.name,
    shop: job?.data?.shopUrl,
    operationId: job?.data?.operationId,
    attemptsMade: job?.attemptsMade || 0,
    maxAttempts: getMaxAttempts(job),
    errorCode,
  });
});

productSyncWorker.on("error", (err) => {
  logger.error("Product sync execute worker error", {
    worker: "productSyncExecuteWorker",
    queue: PRODUCT_SYNC_QUEUE_NAME,
    errorCode: normalizeProductSyncErrorCode(err),
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
    errorCode: normalizeProductSyncErrorCode(err),
  });
});

productSyncSchedulerWorker.on("error", (err) => {
  logger.error("Product sync scheduler worker error", {
    worker: "productSyncSchedulerWorker",
    queue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
    errorCode: normalizeProductSyncErrorCode(err),
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
  let lastId = null;
  const BATCH_SIZE = 50;

  while (true) {
    const stores = await db.store.findMany({
      where: {
        ...(lastId ? { id: { gt: lastId } } : {}),
        OR: [
          { isProductSyncing: true, productSyncStartedAt: { lt: cutoff } },
          { isProductInitiallySyncing: true, updatedAt: { lt: cutoff } },
          { syncProgressStage: { in: ["SHOPIFY_BULK_RUNNING", "MIRROR_STAGING"] }, updatedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, shopUrl: true },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });

    if (stores.length === 0) break;

    const storeIds = stores.map((s) => s.id);
    await db.store.updateMany({
      where: { id: { in: storeIds } },
      data: {
        isProductSyncing: false,
        isProductInitiallySyncing: false,
        syncProgressStage: "IDLE",
        hasCompletedShopifyBulkJob: false,
        requiresProductSyncRecovery: true,
        productSyncStartedAt: null,
        lastSyncErrorSummary: "Product sync timed out before mirror activation. Please start sync again.",
        updatedAt: new Date(),
      },
    });

    lastId = stores[stores.length - 1].id;
  }
}

export async function initializeProductSyncWorker() {
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
      errorCode: normalizeProductSyncErrorCode(error),
    });
  } finally {
    await releaseRedisLock({
      connection,
      key: recoveryLock.key,
      token: recoveryLock.token,
    }).catch(() => {});
  }
}

logger.info("Product sync worker booted", {
  executeQueue: PRODUCT_SYNC_QUEUE_NAME,
  schedulerQueue: PRODUCT_SYNC_SCHEDULER_QUEUE_NAME,
  executeConcurrency: readBoundedIntegerEnv("PRODUCT_SYNC_CONCURRENCY", 3, { min: 1, max: 20 }),
  schedulerConcurrency: 1,
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("PRODUCT_SYNC_WORKER_CLOSE_TIMEOUT")), 25_000);
  });

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
      errorCode: normalizeProductSyncErrorCode(error),
    });
    process.exitCode = 1;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default productSyncWorker;
