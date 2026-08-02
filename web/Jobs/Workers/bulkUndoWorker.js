import { Worker } from "bullmq";
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
import { normalizeUndoState } from "../../services/bulkEditExecutionStateService.js";
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
  findUndoHistoryForExecution,
  findUndoSnapshotRows,
  findTrustedUndoItems,
  findUndoStateOnly,
  markUndoItemsSubmitted,
  moveUndoToAwaitingShopify,
  persistUndoConflictChunks,
  persistUndoConflictReport,
  persistUndoItemPreflight,
  transitionUndoFailureOrRequeue,
  updateUndoOperationState,
} from "../../repositories/bulkUndoExecutionRepository.js";

const QUEUE_NAME = process.env.UNDO_QUEUE || "bulk-undo";
const WORKER_NAME = "bulkUndoWorker";

function assertNoRawTargetingPayload(jobData = {}) {
  if (
    Object.prototype.hasOwnProperty.call(jobData, "rawFilterInput") ||
    Object.prototype.hasOwnProperty.call(jobData, "filterAst") ||
    Object.prototype.hasOwnProperty.call(jobData, "legacyQueryFilter")
  ) {
    const error = new Error("RAW_TARGETING_PAYLOAD_FORBIDDEN");
    error.code = "RAW_TARGETING_PAYLOAD_FORBIDDEN";
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
  return Boolean(error?.retryable);
}

const bulkUndoWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    assertNoRawTargetingPayload(job.data || {});
    const {
      shop,
      historyId,
      source = "undo",
      executionId = null,
    } = job.data || {};
    const attempt = getJobAttempt(job);

    if (!shop || !historyId) {
      throw new Error("bulk undo job requires shop and historyId");
    }

    let shopLockKey = null;
    const leaseOwnerId = buildLeaseOwnerId("bulk-undo-worker");
    let leaseHeartbeat = null;

    try {
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
          "shop_work_conflict"
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
          "operation_lease_conflict"
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
      if (!session?.shop || session.shop !== shop) {
        throw new Error("Shop session not available for bulk undo execution");
      }

      const { status } = await getCurrentBulkOperationStatus(session);
      if (status === "RUNNING") {
        throw new RetryableBulkUndoError(
          "Another bulk operation is already running in background",
          "shopify_bulk_busy"
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
      const undoStage = await beginEditHistoryStage({
        historyId,
        shop,
        stage: "undo",
        executionId,
      });
      if (undoStage.state === "completed" || undoStage.state === "running") {
        return toWorkerOperationStatusDto({
          skipped: true,
          reason: `undo_stage_${undoStage.state}`,
          shop,
          historyId,
        });
      }

      const history = await findUndoHistoryForExecution(historyId, shop);

      const rule = Array.isArray(history?.rules) ? history.rules[0] || {} : {};
      const batch =
        history?.batch && typeof history.batch === "object"
          ? history.batch
          : {};
      const undo = normalizeUndoState(history?.undo);
      const undoOperationId =
        String(undo?.undoOperationId || "").trim() || null;
      const limit = batch.size || 75;
      const cursorId = undo.lastChangeRecordId || null;

      const products = await findSuccessfulChangeRecords({
        historyId,
        shop,
        limit,
        cursorId,
      });

      if (!products.length) {
        throw new Error("No original products found to undo changes");
      }
      const snapshotSetId = String(
        history?.batch?.targetSnapshotRef?.snapshotSetId || ""
      ).trim();
      let snapshotRows = [];
      let snapshotByIdentity = new Map();
      let snapshotSource = "change_record_before_values";

      if (snapshotSetId) {
        const snapshotSet = await getFrozenSnapshotSetForExecution({
          shop,
          snapshotSetId,
          operationId:
            String(
              history?.batch?.targetSnapshotRef?.operationId ||
                history.executionIdentity ||
                ""
            ).trim() || undefined,
        });
        snapshotRows = await findUndoSnapshotRows({
          shop,
          snapshotSetId: snapshotSet.id,
          targetKeys: products
            .map((record) => record.targetIdentity)
            .filter(Boolean),
        });
        assertSnapshotItemsFullyIngested(snapshotRows, "undo_worker");
        snapshotByIdentity = new Map(
          snapshotRows.map((row) => [
            `${String(row.targetKey)}\u001f${String(row.fieldPath)}`,
            row,
          ])
        );
        snapshotSource = "target_snapshot";
      }

      const service = new UndoEditService(session);
      const reconstructedReplayProducts = service.buildUndoReplayRecords(
        products,
        snapshotByIdentity
      );
      const immutableUndoItems = await findTrustedUndoItems({
        shop,
        undoOperationId,
      });
      const undoReplayProducts = service.hydrateReplayRecordsFromUndoItems(
        reconstructedReplayProducts,
        immutableUndoItems
      );
      const snapshotIdentitySet = new Set(
        snapshotRows.map((row) => row.targetKey)
      );
      const replayableProducts = snapshotSetId
        ? undoReplayProducts.filter(
            (record) =>
              record.targetIdentity &&
              snapshotIdentitySet.has(record.targetIdentity)
          )
        : undoReplayProducts.filter((record) => record.targetIdentity);
      if (!replayableProducts.length) {
        const err = new Error("UNDO_TARGET_IDENTITY_MISMATCH");
        err.code = "UNDO_TARGET_IDENTITY_MISMATCH";
        throw err;
      }

      await clearKeyCaches(`${shop}:fetchHistories`);
      const { safeProducts, conflicts, observations } =
        await service.verifyUndoConflicts(
          replayableProducts,
          immutableUndoItems
        );
      await persistUndoItemPreflight({
        shop,
        undoOperationId,
        observations,
      });
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
          outcomeStatus: "processing",
          executionState: "applying",
          startedAt: new Date(),
        },
      });
      if (!safeProducts.length) {
        const err = new Error("UNDO_CONFLICT_REQUIRES_CONFIRMATION");
        err.code = "UNDO_CONFLICT_REQUIRES_CONFIRMATION";
        err.details = { conflicts };
        throw err;
      }
      await assertOperationLeaseOwnership({
        shop,
        namespace: "bulk_undo_execution",
        resourceId: historyId,
        ownerId: leaseOwnerId,
      });
      const { shopifyBulkOperationId, lastProductId, count } =
        await service.undoEditBulkOperation(safeProducts, rule.field);
      await markUndoItemsSubmitted({
        shop,
        undoOperationId,
        targetIdentities: safeProducts
          .map((record) => record.targetIdentity)
          .filter(Boolean),
      });

      const movedAwaitingShopify = await moveUndoToAwaitingShopify({
        historyId,
        shop,
        undo,
        batch,
        expectedExecutionId: executionId || undo.executionIdentity || null,
        shopifyBulkOperationId,
        cursorId,
        lastProductId,
        count,
        limit,
        conflicts,
      });
      if (movedAwaitingShopify.count !== 1) {
        throw new Error("BULK_UNDO_STATE_TRANSITION_REJECTED_AWAITING_SHOPIFY");
      }
      await updateUndoOperationState({
        undoOperationId,
        shop,
        data: {
          outcomeStatus: "processing",
          executionState: "awaiting_shopify",
          shopifyBulkOperationId,
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
          shopifyBulkOperationId,
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
        snapshotSource,
        shopifyBulkOperationId,
      });

      return toWorkerOperationStatusDto({
        success: true,
        shop,
        historyId,
        shopifyBulkOperationId,
      });
    } catch (error) {
      await failEditHistoryStage({
        historyId,
        shop,
        stage: "undo",
        executionId,
        retryable: isRetryableError(error),
        error: error.message,
      }).catch(() => {});
      const existing = await findUndoStateOnly(historyId, shop).catch(
        () => null
      );

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
        const undoOperationId =
          String(undo?.undoOperationId || "").trim() || null;
        await updateUndoOperationState({
          undoOperationId,
          shop,
          data: isRetryableError(error)
            ? {
                outcomeStatus: "pending",
                executionState: "queued",
                failureCode: null,
                failureMessage: null,
              }
            : {
                outcomeStatus: "failed",
                executionState: "failed",
                failureCode: String(error?.code || "BULK_UNDO_WORKER_FAILURE"),
                failureMessage: String(error?.message || "Undo worker failed"),
              },
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
  { connection, concurrency: 1 }
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

  if (isRetryExhausted(job)) {
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
  }
});

export default bulkUndoWorker;
