import fs from "fs";
import os from "os";
import path from "path";
import { format } from "@fast-csv/format";
import { QueueEvents, Worker } from "bullmq";
import logger from "../../utils/loggerUtils.js";
import { connection, createRedisConnection } from "../../config/redis.js";
import { addbulkExportJob } from "../Queues/bulkExportJob.js";
import { uploadCsvToCloudinary } from "../../utils/uploadCsvToCloudinary.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { finalizeScheduledExportRunFromExportJob } from "../../services/scheduledExportExecutionService.js";
import {
  computeTargetSetHash,
  getFrozenTargetProductIds,
} from "../../services/productService/productTargetingService.js";
import {
  acquireExclusiveShopWork,
  LOCK_NS,
  releaseExclusiveShopWork,
} from "../../services/shopWorkLeaseService.js";
import {
  getJobAttempt,
  isRetryExhausted,
  recordRetryExhausted,
} from "../../utils/workerTelemetry.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { recordMirrorAnomaly } from "../../services/mirrorAnomalyService.js";
import {
  acquireShopifyExecutionBudget,
  releaseShopifyExecutionBudget,
} from "../../services/shopifyApiBudgetService.js";
import { recordDeadLetterJob } from "../../services/deadLetterRecoveryService.js";
import { toWorkerOperationStatusDto } from "../../dtos/workerOperationStatusDto.js";
import {
  checkpointExportCursor,
  claimExportJobExecution,
  finalizeExportSuccessState,
  findExportOperationState,
  findExportTerminalFlags,
  findProductsForExport,
  markExportCancelled,
  markExportFailureState,
  markExportFinalizing,
  markExportPaused,
  markExportRetryableState,
} from "../../repositories/bulkExportExecutionRepository.js";
import {
  assertSupportedExportFields,
  buildExportCsvHeaders,
  buildExportCsvRow,
  EXPORT_FIELD_GRANULARITY,
} from "../../services/productService/productExportFieldRegistry.js";
import {
  PRODUCT_EXPORT_JOB_NAME,
  PRODUCT_EXPORT_QUEUE_NAME,
} from "../../queues/exportQueue.constants.js";

const QUEUE_NAME = PRODUCT_EXPORT_QUEUE_NAME;
const WORKER_NAME = "bulkExportWorker";
const WORKER_CONCURRENCY = Number(process.env.EXPORT_WORKER_CONCURRENCY || 1);
const WORKER_LOCK_DURATION_MS = Number(process.env.EXPORT_WORKER_LOCK_DURATION_MS || 120000);
const WORKER_STALLED_INTERVAL_MS = Number(process.env.EXPORT_WORKER_STALLED_INTERVAL_MS || 60000);
const WORKER_MAX_STALLED_COUNT = Number(process.env.EXPORT_WORKER_MAX_STALLED_COUNT || 1);
const SHOP_WORK_LOCK_TTL_MS = Number(process.env.EXPORT_SHOP_WORK_LOCK_TTL_MS || 120000);
const RETRYABLE_EXPORT_DEFER_DELAY_MS = Number(process.env.EXPORT_RETRYABLE_DEFER_DELAY_MS || 60000);

logger.info("Bulk export worker module loaded", {
  worker: WORKER_NAME,
  queue: QUEUE_NAME,
  concurrency: WORKER_CONCURRENCY,
});

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

class RetryableExportError extends Error {
  constructor(message, code = "retryable_export") {
    super(message);
    this.name = "RetryableExportError";
    this.retryable = true;
    this.code = code;
  }
}

function isRetryableError(error) {
  return Boolean(error?.retryable);
}

function endCsvAndWaitForFile({ csvStream, writeStream }) {
  return new Promise((resolve, reject) => {
    writeStream.once("finish", resolve);
    writeStream.once("error", reject);
    csvStream.once("error", reject);
    csvStream.end();
  });
}

async function deferRetryableExportJob({ job, shop, exportJobId, executionId, source, error }) {
  const delayMs = Number.isFinite(RETRYABLE_EXPORT_DEFER_DELAY_MS) && RETRYABLE_EXPORT_DEFER_DELAY_MS > 0
    ? Math.floor(RETRYABLE_EXPORT_DEFER_DELAY_MS)
    : 60000;
  const retryReason = error?.code === "shop_work_conflict" || error?.code === "shop_export_busy"
    ? "shop_work_conflict"
    : error?.code || "retryable_export";

  await addbulkExportJob(
    {
      ...(job?.data || {}),
      exportJobId,
      shop,
      executionId,
      source,
    },
    {
      delay: delayMs,
      jobId: `product-export:${shop}:${exportJobId}:retry:${Date.now()}`,
    },
  );

  logger.warn("Bulk export worker deferred retryable export job", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id || null,
    exportJobId,
    shop,
    executionId,
    delayMs,
    reason: retryReason,
  });

  return toWorkerOperationStatusDto({
    deferred: true,
    requeued: true,
    delayMs,
    reason: retryReason,
    shop,
    exportJobId,
  });
}

const bulkExportWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    assertNoRawTargetingPayload(job.data || {});
    const { exportJobId, shop, selectedFieldKeys, source = "export", executionId = null } = job.data || {};
    const attempt = getJobAttempt(job);

    if (!exportJobId || !shop || !executionId) {
      logger.error("Bulk export worker received invalid payload", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job?.id,
        payloadKeys: Object.keys(job.data || {}),
        hasExportJobId: Boolean(exportJobId),
        hasShop: Boolean(shop),
        hasExecutionId: Boolean(executionId),
      });
      throw new Error("bulk export job requires exportJobId, shop, and executionId");
    }

    let filePath = null;
    let shopLockKey = null;
    let budgetLeases = null;

    try {
      await job.updateProgress({ stage: "initializing", pct: 5 });
      const lock = await acquireExclusiveShopWork({
        shop,
        activity: "bulk_export_execution",
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job.id,
        entityType: "exportJob",
        entityId: exportJobId,
        executionId,
        namespace: LOCK_NS.WRITE_CATALOG,
        ttlMs: SHOP_WORK_LOCK_TTL_MS,
      });

      if (!lock.acquired) {
        throw new RetryableExportError(
          "Another heavy job is already running for this shop",
          "shop_work_conflict",
        );
      }

      shopLockKey = lock.lockKey;
      const budget = await acquireShopifyExecutionBudget({
        shop,
        ownerId: exportJobId,
        queueName: QUEUE_NAME,
        destructive: false,
      });
      if (!budget.acquired) {
        throw new RetryableExportError(
          `Shopify API budget unavailable: ${budget.reason}`,
          budget.reason || "shopify_api_budget_unavailable",
        );
      }
      budgetLeases = budget.leases;

      const claimResult = await claimExportJobExecution({
        exportJobId,
        shop,
        executionId,
        jobId: job.id,
        attempt,
      });
      const exportJob = claimResult.exportJob;

      if (!exportJob) {
        throw new Error("Export job not found");
      }
      await job.updateProgress({ stage: "claimed", pct: 15 });

      if (["terminal", "paused", "not_claimed", "finalizing", "uploaded_pending_finalize"].includes(claimResult.state)) {
        return toWorkerOperationStatusDto({ skipped: true, reason: claimResult.state, shop, exportJobId });
      }

      if (claimResult.state === "shop_busy") {
        throw new RetryableExportError(
          "Another export is already processing for this shop",
          "shop_export_busy",
        );
      }
      const expectedTargetSetHash = exportJob?.targetingSnapshotMeta?.targetSetHash || null;
      if (expectedTargetSetHash && exportJob?.targetProductMirrorBatchId) {
        const actualTargetSetHash = await computeTargetSetHash({
          ownerType: "EXPORT_JOB",
          ownerId: exportJobId,
          shop,
          mirrorBatchId: exportJob.targetProductMirrorBatchId,
        });
        if (actualTargetSetHash !== expectedTargetSetHash) {
          const integrityError = new Error("FAILED_SNAPSHOT_INTEGRITY");
          integrityError.code = "FAILED_SNAPSHOT_INTEGRITY";
          throw integrityError;
        }
      }

      await clearKeyCaches(`${shop}:fetchExportHistories:`);

      filePath = path.join(os.tmpdir(), exportJob.generatedFilename);
      const writeStream = fs.createWriteStream(filePath);
      const selectedFields =
        Array.isArray(selectedFieldKeys) && selectedFieldKeys.length
          ? selectedFieldKeys
          : exportJob.selectedFieldKeys;
      const targetGranularity =
        String(exportJob.targetGranularity || EXPORT_FIELD_GRANULARITY.PRODUCT)
          .trim()
          .toUpperCase() === EXPORT_FIELD_GRANULARITY.VARIANT
          ? EXPORT_FIELD_GRANULARITY.VARIANT
          : EXPORT_FIELD_GRANULARITY.PRODUCT;
      const fieldDefinitions = assertSupportedExportFields(selectedFields, {
        targetGranularity,
      });
      const csvHeaders = buildExportCsvHeaders(fieldDefinitions);

const csvStream = format({
  headers: csvHeaders,
});
      csvStream.pipe(writeStream);

      const pageSize = 500;
      let cursorOrdinal = Number.isInteger(exportJob.executionCursorOrdinal)
        ? exportJob.executionCursorOrdinal
        : null;
      let totalRows = 0;

      while (true) {
        const operationState = await findExportOperationState(exportJobId, shop);
        if (operationState?.cancelRequestedAt) {
          await markExportCancelled(exportJobId, shop, executionId);
          break;
        }
        if (operationState?.pauseRequestedAt) {
          await markExportPaused({ exportJobId, shop, cursorOrdinal, executionId });
          break;
        }

        const snapshotPage = await getFrozenTargetProductIds({
          ownerType: "EXPORT_JOB",
          ownerId: exportJobId,
          shop,
          mirrorBatchId: exportJob.targetProductMirrorBatchId,
          normalizedFilterHash: exportJob.normalizedFilterHash || null,
          limit: pageSize,
          cursorOrdinal,
        });

        const productIds = snapshotPage.rows.map((row) => row.productId);
        if (!productIds.length) {
          break;
        }

        const products = await findProductsForExport({
          shop,
          productIds,
          mirrorBatchId: exportJob.targetProductMirrorBatchId,
        });

        const productMap = new Map(products.map((product) => [product.id, product]));

        for (const productId of productIds) {
          const product = productMap.get(productId);
          if (!product) continue;

          if (targetGranularity === EXPORT_FIELD_GRANULARITY.PRODUCT) {
            csvStream.write(buildExportCsvRow({ fieldDefinitions, product }));
            totalRows += 1;
            if (totalRows % 1000 === 0) {
              await job.updateProgress({ stage: "streaming_csv", pct: 60, rows: totalRows });
            }
            continue;
          }

          const variants = product.variants?.length ? product.variants : [null];
          for (const variant of variants) {
            csvStream.write(buildExportCsvRow({ fieldDefinitions, product, variant }));
            totalRows += 1;
            if (totalRows % 1000 === 0) {
              await job.updateProgress({ stage: "streaming_csv", pct: 60, rows: totalRows });
            }
          }
        }

        cursorOrdinal = snapshotPage.lastOrdinal;
        const cursorCheckpoint = await checkpointExportCursor({
          exportJobId,
          shop,
          cursorOrdinal,
          executionId,
        });
        if (cursorCheckpoint.count !== 1) {
          throw new Error("EXPORT_CURSOR_CHECKPOINT_REJECTED");
        }
        if (cursorOrdinal === null || cursorOrdinal === undefined) {
          break;
        }
      }

      const cancelled = await findExportTerminalFlags(exportJobId, shop);
      if (String(cancelled?.statusNormalized || "").toUpperCase() === "CANCELLED") {
        await endCsvAndWaitForFile({ csvStream, writeStream });
        if (filePath) {
          await fs.promises.unlink(filePath).catch(() => {});
          filePath = null;
        }
        return toWorkerOperationStatusDto({ skipped: true, reason: "cancelled_during_execution", shop, exportJobId });
      }
      if (String(cancelled?.executionState || "").toUpperCase() === "PAUSED") {
        await endCsvAndWaitForFile({ csvStream, writeStream });
        if (filePath) {
          await fs.promises.unlink(filePath).catch(() => {});
          filePath = null;
        }
        return toWorkerOperationStatusDto({ skipped: true, reason: "paused_during_execution", shop, exportJobId });
      }

      await endCsvAndWaitForFile({ csvStream, writeStream });

      const movedToFinalizing = await markExportFinalizing(
        exportJob.id,
        exportJob.shop,
        executionId,
      );
      if (!movedToFinalizing) {
        throw new Error("Export could not transition to finalizing");
      }

      const downloadUrl = await uploadCsvToCloudinary(
        filePath,
        exportJob.id,
        exportJob.generatedFilename,
      );
      await job.updateProgress({ stage: "uploaded", pct: 90, rows: totalRows });

      await fs.promises.unlink(filePath).catch(() => {});
      filePath = null;

      const finalized = await finalizeExportSuccessState(
        exportJob,
        downloadUrl,
        totalRows,
        executionId,
      );
      if (!finalized) {
        throw new Error("Export completion state could not be persisted safely");
      }

      await finalizeScheduledExportRunFromExportJob({
  exportJobId,
  shop,
  status: "SUCCESS",
}).catch((err) => {
  logger.error("Failed to finalize scheduled export run", {
    exportJobId,
    shop,
    error: err.message,
    stack: err.stack,
  });
});

      await clearKeyCaches(`${shop}:fetchExportHistories:`);

      logger.info("Bulk export worker completed export generation", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job.id,
        shop,
        exportJobId,
        executionId,
        attempt,
        totalRows,
        source,
      });

      await job.updateProgress({ stage: "completed", pct: 100, rows: totalRows });
      return toWorkerOperationStatusDto({
        success: true,
        exportJobId,
        totalRows,
        shop,
      });
    } catch (error) {
      logger.error("Bulk export worker failed during execution", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job?.id,
        shop,
        exportJobId,
        executionId,
        attempt,
        message: error.message,
        source,
      });

      if (isRetryableError(error)) {
        await markExportRetryableState({
          exportJobId,
          shop,
          error,
          attempt,
          details: {
            source,
            worker: WORKER_NAME,
            queue: QUEUE_NAME,
            jobId: job?.id || null,
            executionId,
          },
        }).catch(() => {});
      } else {
        await markExportFailureState({
          exportJobId,
          shop,
          error,
          attempt,
          source,
          executionId,
        });

        await finalizeScheduledExportRunFromExportJob({
  exportJobId,
  shop,
  status: "FAILED",
  errorMessage: error.message,
}).catch((err) => {
  logger.error("Failed to finalize scheduled export run on failure", {
    exportJobId,
    shop,
    error: err.message,
  });
});

        await recordMirrorAnomaly({
          shop,
          severity: "high",
          type: "bulk_export_worker_failure",
          entityType: "exportJob",
          entityId: exportJobId,
          message: error.message,
          details: {
            worker: WORKER_NAME,
            queue: QUEUE_NAME,
            jobId: job?.id || null,
            executionId,
            attempt,
            source,
          },
        }).catch(() => {});
      }

      await clearKeyCaches(`${shop}:fetchExportHistories:`);

      if (filePath) {
        await fs.promises.unlink(filePath).catch(() => {});
      }

      await logWorkerError({
        shop,
        err: error,
        source: "bulkExportWorker",
        metadata: {
          queue: QUEUE_NAME,
          worker: WORKER_NAME,
          jobId: job?.id || null,
          exportJobId,
          executionId,
          attempt,
          source,
          retryable: isRetryableError(error),
        },
      });
      if (!isRetryableError(error)) {
        await recordDeadLetterJob({
          shop,
          queueName: QUEUE_NAME,
          queueJobName: PRODUCT_EXPORT_JOB_NAME,
          jobId: job?.id || null,
          payload: job?.data || null,
          error,
          attempts: attempt,
          recoverable: false,
          lastErrorCode: error?.code || null,
        }).catch(() => {});
      }

      if (isRetryableError(error)) {
        return deferRetryableExportJob({
          job,
          shop,
          exportJobId,
          executionId,
          source,
          error,
        });
      }

      throw error;
    } finally {
      await releaseShopifyExecutionBudget({ shop, leases: budgetLeases });
      await releaseExclusiveShopWork(shopLockKey);
    }
  },
  {
    connection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: WORKER_LOCK_DURATION_MS,
    stalledInterval: WORKER_STALLED_INTERVAL_MS,
    maxStalledCount: WORKER_MAX_STALLED_COUNT,
  },
);

export const bulkExportQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection(),
});

bulkExportWorker.on("ready", () => {
  logger.info("Bulk export worker started", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    concurrency: WORKER_CONCURRENCY,
    lockDurationMs: WORKER_LOCK_DURATION_MS,
  });
});

bulkExportWorker.on("active", (job) => {
  logger.info("Bulk export worker picked job", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    exportJobId: job?.data?.exportJobId,
    shop: job?.data?.shop,
  });
});

bulkExportWorker.on("stalled", (jobId) => {
  logger.warn("Bulk export worker job stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkExportWorker.on("error", (error) => {
  logger.error("Bulk export worker runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: error?.message || String(error),
    stack: error?.stack,
  });
});

bulkExportWorker.on("failed", async (job, error) => {
  logger.error("Bulk export worker failed job", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    exportJobId: job?.data?.exportJobId,
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
      entityType: "exportJob",
      entityId: job?.data?.exportJobId,
      executionId: job?.data?.executionId || null,
      message: "Bulk export worker exhausted retries",
      details: {
        source: job?.data?.source || null,
      },
    });
  }
});

bulkExportQueueEvents.on("waiting", ({ jobId }) => {
  logger.info("Bulk export queue event waiting", {
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkExportQueueEvents.on("active", ({ jobId, prev }) => {
  logger.info("Bulk export queue event active", {
    queue: QUEUE_NAME,
    jobId,
    prev,
  });
});

bulkExportQueueEvents.on("completed", ({ jobId, returnvalue }) => {
  logger.info("Bulk export queue event completed", {
    queue: QUEUE_NAME,
    jobId,
    returnvalue,
  });
});

bulkExportQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Bulk export queue event failed", {
    queue: QUEUE_NAME,
    jobId,
    failedReason,
  });
});

bulkExportQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Bulk export queue event stalled", {
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkExportQueueEvents.on("error", (error) => {
  logger.error("Bulk export queue events runtime error", {
    queue: QUEUE_NAME,
    message: error?.message || String(error),
    stack: error?.stack,
  });
});

export default bulkExportWorker;
