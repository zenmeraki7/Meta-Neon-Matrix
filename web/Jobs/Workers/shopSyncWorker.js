// web/Jobs/Workers/shopSyncWorker.js

import crypto from "node:crypto";
import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { startBulkOperationToFetchProducts } from "../../services/productService/productSyncService.js";
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
  isRetryExhausted,
  recordRetryExhausted,
} from "../../utils/workerTelemetry.js";
import { SHOP_SYNC_QUEUE_NAME } from "../../queues/shopSyncQueue.constants.js";
import { shopSyncDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { requireShopDomain, requireStoreId } from "../../utils/identity.js";

function readBoundedIntegerEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const QUEUE_NAME = SHOP_SYNC_QUEUE_NAME;
const MIRROR_SYNC_OPERATION_TYPE = "MIRROR_SYNC";
const MIRROR_SYNC_TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const ACTIVE_BULK_OPERATION_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);
const SUPPORTED_SYNC_TYPES = new Set(["product", "collection"]);

const MIRROR_SYNC_TRANSITIONS = Object.freeze({
  QUEUED: new Set(["STARTING_BULK_QUERY", "CANCELLED", "FAILED"]),
  RETRYABLE_FAILURE: new Set(["STARTING_BULK_QUERY", "CANCELLED", "FAILED"]),
  STARTING_BULK_QUERY: new Set(["SUBMITTING", "RETRYABLE_FAILURE", "FAILED", "CANCELLED"]),
  SUBMITTING: new Set(["RUNNING", "RECONCILE_SUBMITTED", "RETRYABLE_FAILURE", "FAILED", "CANCELLED"]),
  RUNNING: new Set(["RECONCILE_SUBMITTED", "COMPLETED", "FAILED", "CANCEL_REQUESTED"]),
  RECONCILE_SUBMITTED: new Set(["RUNNING", "COMPLETED", "FAILED", "CANCELLED"]),
});

const ALLOWED_JOB_KEYS = new Set([
  "storeId",
  "shopDomain",
  "syncType",
  "reason",
  "syncOperationId",
  "idempotencyKey",
]);

function normalizeShopSyncJobData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("Invalid shop sync job payload");
    error.code = "INVALID_JOB_DATA";
    error.nonRetryable = true;
    throw error;
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_JOB_KEYS.has(key)) {
      const error = new Error(`Invalid job data key: ${key}`);
      error.code = "INVALID_JOB_DATA_KEY";
      error.nonRetryable = true;
      throw error;
    }
  }

  const shopDomain = requireShopDomain(data.shopDomain);
  if (!shopDomain) {
    const error = new Error("Invalid shop domain");
    error.code = "INVALID_SHOP_DOMAIN";
    error.nonRetryable = true;
    throw error;
  }

  const syncOperationId = data.syncOperationId ? String(data.syncOperationId).trim() : null;
  if (!syncOperationId || syncOperationId.length > 128) {
    const error = new Error("Invalid sync operation ID");
    error.code = "INVALID_SYNC_OPERATION_ID";
    error.nonRetryable = true;
    throw error;
  }

  const rawSyncType = String(data.syncType || "").trim();
  const normalizedSyncType = rawSyncType === "FULL_SYNC" ? "product" : rawSyncType.toLowerCase();
  if (!SUPPORTED_SYNC_TYPES.has(normalizedSyncType)) {
    const error = new Error(`Unsupported sync type: ${data.syncType}`);
    error.code = "UNSUPPORTED_SYNC_TYPE";
    error.nonRetryable = true;
    throw error;
  }

  return Object.freeze({
    storeId: data.storeId ? String(data.storeId).trim() : null,
    shopDomain,
    syncType: normalizedSyncType,
    reason: String(data.reason || "MANUAL").toUpperCase(),
    syncOperationId,
  });
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
  const code = error?.code || String(error?.message || "");
  return ![
    "SHOP_SYNC_LOCK_BUSY",
    "RETRYABLE_LOCK_BUSY",
    "SHOPIFY_QUERY_BULK_OPERATION_ACTIVE",
    "SHOPIFY_BULK_SUBMIT_LOCK_BUSY",
  ].some((c) => code.includes(c));
}

// Item 11: Hash lock-key tenant components
async function acquireShopSyncLock({ redis, shop, syncType, ttlMs = 15 * 60 * 1000 }) {
  const shopHash = crypto.createHash("sha256").update(String(shop).toLowerCase()).digest("hex").slice(0, 24);
  const key = `lock:shop:${shopHash}:sync:${syncType}`;
  const token = crypto.randomUUID();
  const acquired = await redis.set(key, token, "NX", "PX", ttlMs);
  return acquired === "OK" ? { key, token } : null;
}

async function renewShopSyncLock({ redis, key, token, ttlMs = 15 * 60 * 1000 }) {
  if (!key || !token) return false;
  const result = await redis.eval(
    `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    end
    return 0
    `,
    1,
    key,
    token,
    ttlMs,
  );
  return result === 1;
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
  const fromList = Array.isArray(from) ? from : [from];
  for (const srcState of fromList) {
    const allowedTargets = MIRROR_SYNC_TRANSITIONS[srcState];
    if (allowedTargets && !allowedTargets.has(String(to))) {
      const error = new Error(`Disallowed mirror sync transition edge: ${srcState} -> ${to}`);
      error.code = "INVALID_TRANSITION_EDGE";
      throw error;
    }
  }

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
  // Item 28: Discard malformed job payloads
  let command;
  try {
    command = normalizeShopSyncJobData(job.data);
  } catch (error) {
    await job.discard().catch(() => { });
    throw error;
  }
  const shop = command.shopDomain;

  logger.info("Shop sync worker started", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId: job.id,
    shop: command.shopDomain,
    syncType: command.syncType,
    syncOperationId: command.syncOperationId,
    attemptsMade: job.attemptsMade,
  });
  await job.updateProgress({ stage: "validated", percent: 10 });

  const operation = await db.operationFingerprint.findFirst({
    where: {
      id: command.syncOperationId,
      shop,
      operationType: MIRROR_SYNC_OPERATION_TYPE,
    },
    select: {
      id: true,
      shop: true,
      status: true,
      fingerprintResourceType: true,
      resourceId: true,
    },
  });

  if (!operation) {
    await job.discard().catch(() => { });
    const error = new Error("Mirror sync operation was not found");
    error.code = "MIRROR_SYNC_OPERATION_NOT_FOUND";
    error.nonRetryable = true;
    throw error;
  }

  // Item 29 & 30: Combined store identity check without logging raw mismatched credentials
  const store = await db.store.findFirst({
    where: {
      id: command.storeId || undefined,
      shopUrl: shop,
    },
    select: {
      id: true,
      shopUrl: true,
      installationStatus: true,
    },
  });

  if (!store || store.installationStatus !== "INSTALLED") {
    await transitionMirrorSyncLedger({
      shop,
      syncOperationId: command.syncOperationId,
      from: ["STARTING_BULK_QUERY", "SUBMITTING", "RETRYABLE_FAILURE", "QUEUED"],
      to: "CANCELLED",
      data: {
        lastErrorSummary: !store ? "Store not found or identity mismatch." : "Shop is uninstalled.",
        lastErrorCode: !store ? "STORE_IDENTITY_MISMATCH" : "SHOP_UNINSTALLED",
      },
    }).catch(() => { });

    return {
      skipped: true,
      reason: !store ? "store_identity_mismatch" : "shop_uninstalled",
    };
  }

  const submissionLock = await acquireShopSyncLock({
    redis: connection,
    shop,
    syncType: command.syncType,
  });
  if (!submissionLock) {
    const lockBusyError = new Error("SHOP_SYNC_LOCK_BUSY");
    lockBusyError.code = "RETRYABLE_LOCK_BUSY";
    lockBusyError.retryable = true;
    throw lockBusyError;
  }

  let exclusiveShopLockKey = null;
  let lockHeartbeat = null;

  try {
    const movedToStarting = await transitionMirrorSyncLedger({
      shop,
      syncOperationId: command.syncOperationId,
      from: ["QUEUED", "RETRYABLE_FAILURE"],
      to: "STARTING_BULK_QUERY",
      data: { lastErrorSummary: null, lastErrorCode: null },
    });

    if (!movedToStarting) {
      // Item 31: Explicit handling for all terminal and active states
      if (MIRROR_SYNC_TERMINAL_STATUSES.has(String(operation.status).toUpperCase())) {
        return {
          skipped: true,
          reason: `mirror_sync_already_${String(operation.status).toLowerCase()}`,
          syncOperationId: command.syncOperationId,
        };
      }
      if (
        operation.status === "RUNNING" &&
        operation.fingerprintResourceType === "shopify_bulk_operation" &&
        operation.resourceId
      ) {
        return {
          skipped: true,
          reason: "shopify_bulk_operation_already_submitted",
          shopifyBulkOperationId: operation.resourceId,
        };
      }
      if (operation.status === "RECONCILE_SUBMITTED") {
        return {
          skipped: true,
          reason: "mirror_sync_requires_reconciliation",
          shopifyBulkOperationId: operation.resourceId || null,
        };
      }
      throw new Error(`MIRROR_SYNC_NOT_CLAIMABLE_FROM_${operation.status || "UNKNOWN"}`);
    }

    await job.updateProgress({ stage: "ledger_claimed", percent: 20 });

    const exclusiveLock = await acquireExclusiveShopWork({
      shop,
      activity: `shop_${command.syncType}_sync`,
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
      jobId: job.id,
      entityType: "store",
      entityId: shop,
      executionId: `${command.syncType}:${shop}`,
    });

    if (!exclusiveLock.acquired) {
      const lockBusyError = new Error("Another heavy job is already running for this shop");
      lockBusyError.code = "RETRYABLE_LOCK_BUSY";
      lockBusyError.retryable = true;
      throw lockBusyError;
    }

    exclusiveShopLockKey = exclusiveLock.lockKey;

    lockHeartbeat = setInterval(() => {
      void renewShopSyncLock({
        redis: connection,
        key: submissionLock.key,
        token: submissionLock.token,
      });
    }, 60_000);

    const submitting = await db.operationFingerprint.updateMany({
      where: {
        id: command.syncOperationId,
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

    let session;
    let bulkStatus;
    try {
      session = await getSession(shop);
      bulkStatus = await getCurrentBulkOperationStatus(session, "QUERY");
    } catch (error) {
      if (isAuthGone(error)) {
        await transitionMirrorSyncLedger({
          shop,
          syncOperationId: command.syncOperationId,
          from: ["STARTING_BULK_QUERY", "SUBMITTING", "RUNNING", "RETRYABLE_FAILURE"],
          to: "CANCELLED",
          data: {
            lastErrorCode: "SHOPIFY_AUTH_REVOKED",
            lastErrorSummary: "Shopify authorization token was revoked.",
          },
        }).catch(() => { });
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
      e.code = "SHOPIFY_QUERY_BULK_OPERATION_ACTIVE";
      e.retryable = true;
      throw e;
    }
    await job.updateProgress({ stage: "bulk_status_checked", percent: 40 });

    const preSubmitLockRenewed = await renewShopSyncLock({
      redis: connection,
      key: submissionLock.key,
      token: submissionLock.token,
    });
    if (!preSubmitLockRenewed) {
      const error = new Error("Shop sync lock lost prior to submission");
      error.code = "LOCK_LOST_BEFORE_SUBMIT";
      error.retryable = true;
      throw error;
    }

    const syncResult = await startBulkOperationToFetchProducts({ session });

    // Item 33: Pass command.syncType ("product") so assertion errors use normalized type
    const startResult = assertSyncStartResult(syncResult, command.syncType);
    if (!startResult.shopifyBulkOperationId) {
      throw new Error("SHOPIFY_BULK_OPERATION_ID_MISSING");
    }
    await job.updateProgress({ stage: "bulk_operation_started", percent: 80 });

    // Item 16: Mark reconciliation pending AFTER confirmed submission
    if (command.syncType === "product") {
      await markInventoryReconciliationPending(shop).catch(() => { });
    }
    if (command.syncType === "collection") {
      await markCollectionReconciliationPending(shop).catch(() => { });
    }

    const transitionedToRunning = await transitionMirrorSyncLedger({
      shop,
      syncOperationId: command.syncOperationId,
      from: "SUBMITTING",
      to: "RUNNING",
      data: {
        fingerprintResourceType: "shopify_bulk_operation",
        resourceId: String(startResult.shopifyBulkOperationId),
        lastErrorSummary: null,
        lastErrorCode: null,
      },
    });

    if (!transitionedToRunning) {
      await transitionMirrorSyncLedger({
        shop,
        syncOperationId: command.syncOperationId,
        from: "SUBMITTING",
        to: "RECONCILE_SUBMITTED",
        data: {
          fingerprintResourceType: "shopify_bulk_operation",
          resourceId: String(startResult.shopifyBulkOperationId),
          lastErrorCode: "TRANSITION_FAILED_AFTER_SHOPIFY_ACCEPT",
          lastErrorSummary: "RUNNING transition failed after Shopify accepted bulk operation.",
        },
      }).catch(() => { });
      throw Object.assign(
        new Error("MIRROR_SYNC_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE"),
        { retryable: false },
      );
    }
    await job.updateProgress({ stage: "ledger_running", percent: 100 });

    return {
      success: true,
      shop,
      syncType: command.syncType,
      syncOperationId: command.syncOperationId,
      shopifyBulkOperationId: String(startResult.shopifyBulkOperationId),
      syncHistoryId: startResult.syncHistoryId,
    };
  } catch (error) {
    if (error.message === "MIRROR_SYNC_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE") {
      throw error;
    }

    const errorCode = error?.code || "SHOP_SYNC_FAILED";
    const retryable =
      Boolean(error.retryable) ||
      errorCode === "RETRYABLE_LOCK_BUSY" ||
      errorCode === "SHOPIFY_QUERY_BULK_OPERATION_ACTIVE";

    await transitionMirrorSyncLedger({
      shop,
      syncOperationId: command.syncOperationId,
      from: ["QUEUED", "RETRYABLE_FAILURE", "STARTING_BULK_QUERY", "SUBMITTING"],
      to: retryable && !willExhaustRetry(job) ? "RETRYABLE_FAILURE" : "FAILED",
      data: {
        lastErrorCode: errorCode,
        lastErrorSummary: "Shop sync operation failed to complete.",
      },
    }).catch(() => { });

    if (shouldMarkMirrorRepairRequired(error)) {
      await recordMirrorAnomaly({
        shop,
        severity: "medium",
        type: "shop_sync_worker_failure",
        entityType: "store",
        entityId: shop,
        message: "Shop sync worker failure",
        details: { syncType: command.syncType, errorCode },
      }).catch(() => { });

      await markRepairRequired({
        shop,
        reason:
          command.syncType === "collection"
            ? MIRROR_STALE_REASONS.COLLECTION_RECONCILIATION_PENDING
            : MIRROR_STALE_REASONS.INVENTORY_RECONCILIATION_PENDING,
        summary: "Shop sync worker failure",
        severity: "medium",
        details: { syncType: command.syncType, errorCode },
      }).catch(() => { });
    }

    throw error;
  } finally {
    if (lockHeartbeat) {
      clearInterval(lockHeartbeat);
    }
    if (exclusiveShopLockKey) {
      await releaseExclusiveShopWork(exclusiveShopLockKey);
    }
    await releaseShopSyncLock({
      redis: connection,
      key: submissionLock?.key,
      token: submissionLock?.token,
    }).catch(() => { });
  }
}

// Item 39: Exportable worker factory helper
export function createShopSyncWorker({ queueName = QUEUE_NAME, redisConnection = connection } = {}) {
  return new Worker(queueName, processShopSyncJob, {
    connection: redisConnection,
    concurrency: readBoundedIntegerEnv("SHOP_SYNC_CONCURRENCY", 2, { min: 1, max: 20 }),
    lockDuration: readBoundedIntegerEnv("SHOP_SYNC_LOCK_DURATION_MS", 600_000, { min: 60_000, max: 3_600_000 }),
    stalledInterval: readBoundedIntegerEnv("SHOP_SYNC_STALLED_INTERVAL_MS", 60_000, { min: 10_000, max: 600_000 }),
    maxStalledCount: readBoundedIntegerEnv("SHOP_SYNC_MAX_STALLED_COUNT", 1, { min: 1, max: 5 }),
    limiter: {
      max: readBoundedIntegerEnv("SHOP_SYNC_GLOBAL_LIMIT_MAX", 10, { min: 1, max: 100 }),
      duration: readBoundedIntegerEnv("SHOP_SYNC_GLOBAL_LIMIT_DURATION_MS", 1000, { min: 100, max: 60_000 }),
    },
  });
}

const shopSyncWorker = createShopSyncWorker();

const shopSyncQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection(),
});

shopSyncQueueEvents.on("error", (err) => {
  logger.error("Shop sync queue events connection error", {
    queue: QUEUE_NAME,
    errorCode: err?.code || "QUEUE_EVENTS_ERROR",
  });
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
    errorCode: error?.code || "WORKER_RUNTIME_ERROR",
  });
});

shopSyncWorker.on("stalled", (jobId) => {
  logger.warn("Shop sync worker job stalled", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId,
  });
});

// Items 26 & 27: Record retry exhaustion durably first, then enqueue to DLQ with SHA-256 job ID
shopSyncWorker.on("failed", (job, error) => {
  const errorCode = error?.code || "SHOP_SYNC_JOB_FAILED";

  logger.error("Shop sync worker failed", {
    worker: "shopSyncWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    shopDomain: job?.data?.shopDomain,
    syncType: job?.data?.syncType,
    syncOperationId: job?.data?.syncOperationId || null,
    attemptsMade: job?.attemptsMade,
    errorCode,
  });

  if (!isRetryExhausted(job)) return;

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
      errorCode,
    },
  }).catch((recordError) => {
    logger.error("Failed to record retry exhaustion", {
      worker: "shopSyncWorker",
      queue: QUEUE_NAME,
      jobId: job?.id,
      shopDomain: job?.data?.shopDomain,
      errorCode: recordError?.code || "RECORD_RETRY_EXHAUSTED_ERROR",
    });
  });

  const dlqJobIdHash = crypto.createHash("sha256").update(String(job?.id || "").toLowerCase()).digest("hex").slice(0, 24);

  void shopSyncDlqQueue.add(
    "shop-sync-dlq",
    {
      shopDomain: job?.data?.shopDomain || null,
      syncOperationId: job?.data?.syncOperationId || null,
      syncType: job?.data?.syncType || null,
      errorCode,
      failedAt: new Date().toISOString(),
    },
    {
      jobId: `dlq:${QUEUE_NAME}:${dlqJobIdHash}`,
      removeOnComplete: { age: 604800, count: 5000 },
    },
  ).catch((dlqErr) => {
    if (!String(dlqErr?.message || "").includes("Job already exists")) {
      logger.error("Shop sync DLQ enqueue failed", {
        worker: "shopSyncWorker",
        queue: QUEUE_NAME,
        originalJobId: job?.id,
        errorCode: dlqErr?.code || "DLQ_ENQUEUE_ERROR",
      });
    }
  });
});

// Items 34, 35, 36: Removed data-integrity defect (lastFullSyncAt update on submission completion)
shopSyncWorker.on("completed", (job, result) => {
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

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("SHOP_SYNC_WORKER_CLOSE_TIMEOUT")), 25_000);
  });

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
      errorCode: error?.code || "SHUTDOWN_ERROR",
    });
    process.exitCode = 1;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGINT", () => { void shutdown("SIGINT"); });

export default shopSyncWorker;
