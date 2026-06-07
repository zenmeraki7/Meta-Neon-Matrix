import { UnrecoverableError, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import UndoEditService from "../../services/productService/productBulkUndoService.js";
import { getSession } from "../../utils/sessionHandler.js";
import { getCurrentBulkOperationStatus } from "../../utils/bulkOperationHelper.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import {
  acquireExclusiveShopWork,
  LOCK_NS,
  releaseExclusiveShopWork,
} from "../../services/shopWorkLeaseService.js";
import {
  acquireOperationLease,
  assertOperationLeaseOwnership,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";
import {
  getJobAttempt,
  isRetryExhausted,
  recordRetryExhausted,
} from "../../utils/workerTelemetry.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import {
  normalizeUndoState,
} from "../../services/bulkEditExecutionStateService.js";
import {
  beginEditHistoryStage,
  completeEditHistoryStage,
  failEditHistoryStage,
} from "../../services/operationStageIdempotencyService.js";
import { getFrozenSnapshotSetForExecution } from "../../repositories/targetSnapshotSetRepository.js";
import { assertSnapshotItemsFullyIngested } from "../../services/targetSnapshotItemIntegrityService.js";
import { toWorkerOperationStatusDto } from "../../dtos/workerOperationStatusDto.js";
import {
  claimUndoExecution,
  findSuccessfulChangeRecords,
  findExistingUndoChangeRecords,
  findPendingUndoChangeRecords,
  findUndoHistoryForExecution,
  findUndoSnapshotRows,
  findUndoStateOnly,
  markUndoChangeRecordsPrepared,
  moveUndoToAwaitingShopify,
  markUndoReconcileSubmitted,
  moveUndoToAwaitingConfirmation,
  persistUndoConflictChunks,
  persistUndoConflictReport,
  transitionUndoFailureOrRequeue,
  updateUndoOperationState,
} from "../../repositories/bulkUndoExecutionRepository.js";
import { bulkUndoDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const QUEUE_NAME = process.env.UNDO_QUEUE || "bulk-undo";
const DLQ_NAME = process.env.BULK_UNDO_DLQ_QUEUE || "bulk-undo-dlq";
const WORKER_NAME = "bulkUndoWorker";
// Conflict subsets are persisted by the repository as UndoOperationConflictChunk rows using CONFLICT_CHUNK_SIZE.
const ACTIVE_BULK_STATUSES = new Set(["CREATED", "RUNNING", "CANCELING"]);
const RECONCILE_ERROR = "BULK_UNDO_RECONCILE_SUBMITTED_AFTER_TRANSITION_FAILURE";

function assertNoRawTargetingPayload(jobData = {}) {
  if (
    Object.prototype.hasOwnProperty.call(jobData, "filterParams") ||
    Object.prototype.hasOwnProperty.call(jobData, "filterAst") ||
    Object.prototype.hasOwnProperty.call(jobData, "queryFilter")
  ) {
    const error = new Error("RAW_TARGETING_PAYLOAD_FORBIDDEN");
    error.code = "RAW_TARGETING_PAYLOAD_FORBIDDEN";
    error.nonRetryable = true;
    throw error;
  }
}

class RetryableBulkUndoError extends Error {
  constructor(message, code = "retryable_bulk_undo") {
    super(message);
    this.name = "RetryableBulkUndoError";
    this.retryable = true;
    this.code = code;
  }
}

function isRetryableError(error) {
  return Boolean(error?.retryable) && !error?.nonRetryable;
}

function isShopifyAuthError(error) {
  const status = Number(
    error?.statusCode
    || error?.status
    || error?.response?.status
    || error?.response?.statusCode
    || 0,
  );
  return status === 401 || status === 403;
}

const bulkUndoWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { shop, historyId, source = "undo", executionId = null } = job.data || {};
    const attempt = getJobAttempt(job);

    let shopLockKey = null;
    const leaseOwnerId = buildLeaseOwnerId("bulk-undo-worker");
    let leaseHeartbeat = null;

    try {
      assertNoRawTargetingPayload(job.data || {});
      if (!shop || !historyId) {
        const error = new Error("bulk undo job requires shop and historyId");
        error.nonRetryable = true;
        throw error;
      }

      const lock = await acquireExclusiveShopWork({
        shop,
        activity: "bulk_undo_execution",
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job.id,
        entityType: "editHistory",
        entityId: historyId,
        executionId,
        namespace: LOCK_NS.WRITE_CATALOG,
      });

      if (!lock.acquired) {
        throw new RetryableBulkUndoError(
          "Another heavy job is already running for this shop",
          "shop_work_conflict",
        );
      }

      shopLockKey = lock.lockKey;
      const operationLease = await acquireOperationLease({
        shop,
        namespace: "bulk_undo_execution",
        resourceId: historyId,
        ownerId: leaseOwnerId,
      });
      if (!operationLease.acquired) {
        throw new RetryableBulkUndoError(
          "Bulk undo execution lease is already held",
          "operation_lease_conflict",
        );
      }
      leaseHeartbeat = setInterval(() => {
        heartbeatOperationLease({
          shop,
          namespace: "bulk_undo_execution",
          resourceId: historyId,
          ownerId: leaseOwnerId,
        }).catch(() => {});
      }, 60_000);

      const session = await getSession(shop);
      if (!session?.shop || session.shop !== shop || !session?.accessToken) {
        const error = new Error("SHOP_SESSION_NOT_AVAILABLE");
        error.nonRetryable = true;
        throw error;
      }

      const { status } = await getCurrentBulkOperationStatus(session, "MUTATION");
      if (ACTIVE_BULK_STATUSES.has(String(status || "").toUpperCase())) {
        throw new RetryableBulkUndoError(
          `Shopify bulk operation active: ${status}`,
          "shopify_bulk_busy",
        );
      }

      const claimedHistory = await claimUndoExecution({
        historyId,
        shop,
        executionId,
        jobId: job.id,
        attempt,
      });
      if (!claimedHistory) {
        return toWorkerOperationStatusDto({
          skipped: true,
          reason: "undo_already_processing",
          shop,
          historyId,
        });
      }
      const history = await findUndoHistoryForExecution(historyId, shop);

      const rule = Array.isArray(history?.rules) ? history.rules[0] || {} : {};
      const batch = history?.batch && typeof history.batch === "object" ? history.batch : {};
      const undo = normalizeUndoState(history?.undo);
      const undoOperationId = String(undo?.undoOperationId || "").trim() || null;
      const limit = batch.size || 75;
      const cursorId = batch.lastProductId || null;
      const undoEditHistoryId = String(undo?.undoEditHistoryId || "").trim();
      if (!undoEditHistoryId) {
        throw new Error("UNDO_EDIT_HISTORY_ID_REQUIRED");
      }
      const pendingUndoRecords = await findPendingUndoChangeRecords({
        undoEditHistoryId,
        shop,
        limit,
      });

      const products = await findSuccessfulChangeRecords({
        historyId,
        shop,
        limit,
        cursorId: pendingUndoRecords.length ? null : cursorId,
        targetIdentities: pendingUndoRecords.map((record) => record.targetIdentity),
      });

      if (!products.length) {
        throw new Error("No original products found to undo changes");
      }
      const snapshotSetId = String(history?.batch?.targetSnapshotRef?.snapshotSetId || "").trim();
      const sourceIsUndo = String(history?.type || "").toUpperCase() === "UNDO";
      if (!snapshotSetId && !sourceIsUndo) {
        throw new Error("FROZEN_SNAPSHOT_SET_REQUIRED_FOR_UNDO");
      }
      const snapshotSet = sourceIsUndo
        ? null
        : await getFrozenSnapshotSetForExecution({
          shop,
          snapshotSetId,
          operationId:
            String(history?.batch?.targetSnapshotRef?.operationId || history.executionIdentity || "").trim()
            || undefined,
        });
      const snapshotRows = sourceIsUndo
        ? products.map((record) => ({
          id: record.id,
          targetKey: record.targetIdentity,
          plannedMutation: record.afterValues,
          beforeValues: record.beforeValues,
          executionStatus: "VERIFIED",
        }))
        : await findUndoSnapshotRows({
          shop,
          snapshotSetId: snapshotSet.id,
          targetKeys: products.map((record) => record.targetIdentity).filter(Boolean),
        });
      assertSnapshotItemsFullyIngested(snapshotRows, "undo_worker");
      const snapshotByIdentity = new Map(
        snapshotRows.map((row) => [String(row.targetKey), row]),
      );
      const service = new UndoEditService(session);
      const undoReplayProducts = service.buildUndoReplayRecords(
        products,
        snapshotByIdentity,
      );
      const snapshotIdentitySet = new Set(snapshotRows.map((row) => row.targetKey));
      const replayableProducts = undoReplayProducts.filter(
        (record) => record.targetIdentity && snapshotIdentitySet.has(record.targetIdentity),
      );
      if (!replayableProducts.length) {
        const err = new Error("UNDO_TARGET_IDENTITY_MISMATCH");
        err.code = "UNDO_TARGET_IDENTITY_MISMATCH";
        throw err;
      }
      let undoChangeRecords = pendingUndoRecords.length ? pendingUndoRecords : await findExistingUndoChangeRecords({
        undoEditHistoryId,
        shop,
        targetIdentities: replayableProducts.map((record) => record.targetIdentity),
      });
      if (!undoChangeRecords.length) {
        undoChangeRecords = await service.prepareUndoChangeRecords({
          undoEditHistoryId,
          sourceEditHistoryId: historyId,
          products: replayableProducts,
        });
      }
      const pendingUndoTargets = new Set(
        undoChangeRecords
          .filter((record) => String(record.status).toUpperCase() === "PENDING")
          .map((record) => String(record.targetIdentity)),
      );
      const pendingReplayableProducts = replayableProducts.filter((record) =>
        pendingUndoTargets.has(String(record.targetIdentity)));
      if (!pendingReplayableProducts.length) {
        const error = new Error("UNDO_HAS_NO_PENDING_CHANGE_RECORDS");
        error.nonRetryable = true;
        throw error;
      }

      const changeRecordsPrepared = await markUndoChangeRecordsPrepared({
        historyId,
        shop,
        undo,
        expectedExecutionId: executionId || undo.executionIdentity || null,
      });
      if (changeRecordsPrepared.count !== 1) {
        throw new Error("UNDO_CHANGE_RECORDS_PREPARED_TRANSITION_REJECTED");
      }

      const undoStage = await beginEditHistoryStage({
        historyId,
        shop,
        stage: "undo",
        executionId: executionId || undo.executionIdentity || null,
      });
      if (undoStage.state === "completed") {
        return toWorkerOperationStatusDto({
          skipped: true,
          reason: "undo_stage_completed",
          shop,
          historyId,
        });
      }
      if (undoStage.state === "running") {
        throw new RetryableBulkUndoError(
          "Bulk undo stage is already running",
          "undo_stage_running",
        );
      }

      await clearKeyCaches(`${shop}:fetchHistories`);
      const { safeProducts, conflicts } = await service.verifyUndoConflicts(pendingReplayableProducts);
      const conflictReport = {
        generatedAt: new Date().toISOString(),
        totalReplayable: replayableProducts.length,
        safeReplayableCount: safeProducts.length,
        conflictCount: conflicts.length,
        sampleConflicts: conflicts.slice(0, 200),
      };
      await persistUndoConflictChunks({
        shop,
        undoOperationId,
        safeProducts,
        conflicts,
      });
      await persistUndoConflictReport({
        historyId,
        shop,
        undo,
        expectedExecutionId: executionId || undo.executionIdentity || null,
        conflictReport,
        undoOperationId,
        safeProductsCount: safeProducts.length,
        conflictsCount: conflicts.length,
      });
      await updateUndoOperationState({
        undoOperationId,
        shop,
        data: {
          status: "processing",
          state: "dispatching",
        },
      });
      if (!safeProducts.length) {
        const movedConfirmation = await moveUndoToAwaitingConfirmation({
          historyId,
          shop,
          undo,
          expectedExecutionId: executionId || undo.executionIdentity || null,
          conflictReport,
        });
        if (movedConfirmation.count !== 1) {
          throw new Error("UNDO_AWAITING_CONFIRMATION_TRANSITION_REJECTED");
        }
        await updateUndoOperationState({
          undoOperationId,
          shop,
          data: { status: "pending", state: "awaiting_confirmation" },
        });
        await failEditHistoryStage({
          historyId,
          shop,
          stage: "undo",
          executionId: executionId || undo.executionIdentity || null,
          retryable: true,
          checkpoint: { conflictCount: conflicts.length },
          error: "UNDO_CONFLICT_REQUIRES_CONFIRMATION",
        });
        return toWorkerOperationStatusDto({
          skipped: true,
          reason: "undo_conflict_requires_confirmation",
          shop,
          historyId,
          conflictCount: conflicts.length,
        });
      }
      await assertOperationLeaseOwnership({
        shop,
        namespace: "bulk_undo_execution",
        resourceId: historyId,
        ownerId: leaseOwnerId,
      });
      const { bulkOperationId, lastProductId, count } = await service.undoEditBulkOperation(
        safeProducts,
        rule.field,
        { undoEditHistoryId },
      );

      const movedAwaitingShopify = await moveUndoToAwaitingShopify({
        historyId,
        shop,
        undo,
        batch,
        expectedExecutionId: executionId || undo.executionIdentity || null,
        bulkOperationId,
        cursorId,
        lastProductId,
        count,
        limit,
        conflicts,
        undoOperationId,
      });
      if (movedAwaitingShopify.count !== 1) {
        await markUndoReconcileSubmitted({
          historyId,
          shop,
          undo,
          batch,
          expectedExecutionId: executionId || undo.executionIdentity || null,
          bulkOperationId,
          cursorId,
          lastProductId,
          count,
          limit,
        }).catch(() => {});
        throw Object.assign(new Error(RECONCILE_ERROR), { nonRetryable: true });
      }
      await updateUndoOperationState({
        undoOperationId,
        shop,
        data: {
          status: "processing",
          state: "awaiting_shopify",
          bulkOperationId,
          processedCount: Number(undo?.processedCount || 0),
        },
      });
      await assertOperationLeaseOwnership({
        shop,
        namespace: "bulk_undo_execution",
        resourceId: historyId,
        ownerId: leaseOwnerId,
      });
      await completeEditHistoryStage({
        historyId,
        shop,
        stage: "undo",
        executionId: executionId || undo.executionIdentity || null,
        checkpoint: {
          bulkOperationId,
          count,
          lastProductId: lastProductId || null,
        },
      });

      logger.info("Bulk undo worker queued Shopify bulk mutation", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job.id,
        shop,
        historyId,
        executionId: executionId || undo.executionIdentity || null,
        attempt,
        source,
        bulkOperationId,
      });

      return toWorkerOperationStatusDto({
        success: true,
        shop,
        historyId,
        bulkOperationId,
      });
    } catch (error) {
      if (isShopifyAuthError(error)) {
        error.nonRetryable = true;
        error.code = error.code || "SHOPIFY_AUTH_REVOKED";
      }
      if (error.message === RECONCILE_ERROR) {
        throw new UnrecoverableError(error.message);
      }
      await failEditHistoryStage({
        historyId,
        shop,
        stage: "undo",
        executionId,
        retryable: isRetryableError(error),
        error: error.message,
      }).catch(() => {});
      const existing = await findUndoStateOnly(historyId, shop).catch(() => null);

      if (existing) {
        const undo = normalizeUndoState(existing.undo);
        const failOrRequeue = await transitionUndoFailureOrRequeue({
          historyId,
          shop,
          undo,
          expectedExecutionId: executionId || undo.executionIdentity || null,
          error,
          attempt,
          source,
          executionId,
          retryable: isRetryableError(error),
        }).catch(() => {});
        if (failOrRequeue && failOrRequeue.count !== 1) {
          logger.warn("Bulk undo fallback state transition was rejected", {
            worker: WORKER_NAME,
            queue: QUEUE_NAME,
            shop,
            historyId,
            attempt,
            source,
          });
        }
        const undoOperationId = String(undo?.undoOperationId || "").trim() || null;
        await updateUndoOperationState({
          undoOperationId,
          shop,
          data: isRetryableError(error)
            ? { status: "pending", state: "queued" }
            : { status: "failed", state: "failed" },
        }).catch(() => {});
      }

      await clearKeyCaches(`${shop}:fetchHistories`);
      await clearKeyCaches(`${shop}:historyDetails:${historyId}`);

      await recordMirrorAnomaly({
        shop,
        severity: "high",
        type: "bulk_undo_worker_failure",
        entityType: "editHistory",
        entityId: historyId,
        message: error.message,
        details: {
          worker: WORKER_NAME,
          queue: QUEUE_NAME,
          jobId: job?.id || null,
          attempt,
          source,
          executionId,
          retryable: isRetryableError(error),
        },
      }).catch(() => {});

      await logWorkerError({
        shop,
        err: error,
        source: "BulkUndoWorker",
        metadata: {
          queue: QUEUE_NAME,
          worker: WORKER_NAME,
          jobId: job?.id || null,
          historyId,
          attempt,
          source,
          executionId,
          retryable: isRetryableError(error),
        },
      });

      if (error?.nonRetryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      await releaseOperationLease({
        shop,
        namespace: "bulk_undo_execution",
        resourceId: historyId,
        ownerId: leaseOwnerId,
      }).catch(() => {});
      await releaseExclusiveShopWork(shopLockKey);
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: Number(process.env.BULK_UNDO_LOCK_DURATION_MS || 600_000),
    stalledInterval: Number(process.env.BULK_UNDO_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.BULK_UNDO_MAX_STALLED_COUNT || 1),
  },
);

bulkUndoWorker.on("failed", async (job, error) => {
  logger.error("Bulk undo worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    executionId: job?.data?.executionId || null,
    attempt: getJobAttempt(job),
    message: error.message,
  });

  if (isRetryExhausted(job) || error?.name === "UnrecoverableError") {
    await recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      entityType: "editHistory",
      entityId: job?.data?.historyId,
      executionId: job?.data?.executionId || null,
      message: "Bulk undo worker exhausted retries",
      details: {
        source: job?.data?.source || null,
      },
    });
    void bulkUndoDlqQueue.add(
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
      logger.error("Bulk undo DLQ enqueue failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

bulkUndoWorker.on("completed", (job, result) => {
  logger.info("Bulk undo worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

bulkUndoWorker.on("stalled", (jobId) => {
  logger.warn("Bulk undo worker stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkUndoWorker.on("error", (error) => {
  logger.error("Bulk undo worker runtime error", {
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
    await bulkUndoWorker.close();
  } catch (error) {
    logger.error("Bulk undo worker shutdown failed", {
      worker: WORKER_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkUndoWorker;
