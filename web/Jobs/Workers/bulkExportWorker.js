import fs from "fs";
import os from "os";
import path from "path";
import { format } from "@fast-csv/format";
import { Worker } from "bullmq";
import logger from "../../utils/loggerUtils.js";
import { connection } from "../../config/redis.js";
import { uploadCsvToCloudinary } from "../../utils/uploadCsvToCloudinary.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { finalizeScheduledExportRunFromExportJob } from "../../services/scheduledExportExecutionService.js";
import {
  computeTargetSnapshotChecksum,
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

const QUEUE_NAME = process.env.EXPORT_QUEUE || "bulk-export";
const WORKER_NAME = "bulkExportWorker";

function assertNoRawTargetingPayload(jobData = {}) {
  if (
    Object.prototype.hasOwnProperty.call(jobData, "filterParams") ||
    Object.prototype.hasOwnProperty.call(jobData, "filterAst") ||
    Object.prototype.hasOwnProperty.call(jobData, "queryFilter")
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


const bulkExportWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    assertNoRawTargetingPayload(job.data || {});
    const { exportJobId, shop, fields, source = "export", executionId = null } = job.data || {};
    const attempt = getJobAttempt(job);

    if (!exportJobId || !shop || !executionId) {
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
      const expectedSnapshotChecksum = exportJob?.targetingSnapshotMeta?.snapshotChecksum || null;
      if (expectedSnapshotChecksum && exportJob?.targetMirrorBatchId) {
        const actualSnapshotChecksum = await computeTargetSnapshotChecksum({
          ownerType: "EXPORT_JOB",
          ownerId: exportJobId,
          shop,
          mirrorBatchId: exportJob.targetMirrorBatchId,
        });
        if (actualSnapshotChecksum !== expectedSnapshotChecksum) {
          const integrityError = new Error("FAILED_SNAPSHOT_INTEGRITY");
          integrityError.code = "FAILED_SNAPSHOT_INTEGRITY";
          throw integrityError;
        }
      }

      await clearKeyCaches(`${shop}:fetchExportHistories:`);

      filePath = path.join(os.tmpdir(), exportJob.filename);
      const writeStream = fs.createWriteStream(filePath);
      const selectedFields =
        Array.isArray(fields) && fields.length ? fields : exportJob.fields;
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
          mirrorBatchId: exportJob.targetMirrorBatchId,
          filterHash: exportJob.filterHash || null,
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
          mirrorBatchId: exportJob.targetMirrorBatchId,
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
        csvStream.end();
        await new Promise((resolve, reject) => {
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });
        if (filePath) {
          await fs.promises.unlink(filePath).catch(() => {});
          filePath = null;
        }
        return toWorkerOperationStatusDto({ skipped: true, reason: "cancelled_during_execution", shop, exportJobId });
      }
      if (String(cancelled?.executionState || "").toUpperCase() === "PAUSED") {
        csvStream.end();
        await new Promise((resolve, reject) => {
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });
        if (filePath) {
          await fs.promises.unlink(filePath).catch(() => {});
          filePath = null;
        }
        return toWorkerOperationStatusDto({ skipped: true, reason: "paused_during_execution", shop, exportJobId });
      }

      csvStream.end();

      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      const movedToFinalizing = await markExportFinalizing(
        exportJob.id,
        exportJob.shop,
        executionId,
      );
      if (!movedToFinalizing) {
        throw new Error("Export could not transition to finalizing");
      }

      const fileUrl = await uploadCsvToCloudinary(
        filePath,
        exportJob.id,
        exportJob.filename,
      );
      await job.updateProgress({ stage: "uploaded", pct: 90, rows: totalRows });

      await fs.promises.unlink(filePath).catch(() => {});
      filePath = null;

      const finalized = await finalizeExportSuccessState(
        exportJob,
        fileUrl,
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

      return toWorkerOperationStatusDto({
        success: true,
        exportJobId,
        totalRows,
        shop,
      });
      await job.updateProgress({ stage: "completed", pct: 100, rows: totalRows });
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
          jobName: "bulk-export",
          jobId: job?.id || null,
          payload: job?.data || null,
          error,
          attempts: attempt,
          recoverable: false,
          lastErrorCode: error?.code || null,
        }).catch(() => {});
      }

      throw error;
    } finally {
      await releaseShopifyExecutionBudget({ shop, leases: budgetLeases });
      await releaseExclusiveShopWork(shopLockKey);
    }
  },
  { connection, concurrency: 1 },
);

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

export default bulkExportWorker;
