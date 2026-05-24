import fs from "fs";
import os from "os";
import path from "path";
import { format } from "@fast-csv/format";
import { Worker } from "bullmq";
import logger from "../../utils/loggerUtils.js";
import { connection } from "../../config/redis.js";
import { uploadCsvToCloudinary } from "../../utils/uploadCsvToCloudinary.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { prisma } from "../../config/database.js";
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
  EXPORT_EXECUTION_STATES,
  appendSerializedExportError,
  buildExportExecutionError,
  isTerminalExportExecutionState,
} from "../../services/exportExecutionStateService.js";
import {
  acquireShopifyExecutionBudget,
  releaseShopifyExecutionBudget,
} from "../../services/shopifyApiBudgetService.js";
import { recordDeadLetterJob } from "../../services/deadLetterRecoveryService.js";
import {
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
} from "../../utils/normalizedStateUtils.js";

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

const PRODUCT_FIELD_RESOLVERS = {
  title: (p) => p.title ?? "",
  description: (p) => p.descriptionHtml ?? p.descriptionText ?? "",
  vendor: (p) => p.vendor ?? "",
  productType: (p) => p.productType ?? "",
  handle: (p) => p.handle ?? "",
  status: (p) => p.status ?? "",
  metaTitle: (p) => p.seoTitle ?? "",
  metaDescription: (p) => p.seoDescription ?? "",
  tags: (p) => (Array.isArray(p.tags) ? p.tags.join(", ") : ""),
  collections: (p) => {
    const raw = p.collectionsJson;
    if (!Array.isArray(raw)) return "";
    return raw.map((collection) => collection?.title).filter(Boolean).join(", ");
  },
  category: (p) => p.categoryName ?? "",
};

const VARIANT_FIELD_RESOLVERS = {
  price: (v) => v.price ?? "",
  compareAtPrice: (v) => v.compareAtPrice ?? "",
  sku: (v) => v.sku ?? "",
  barcode: (v) => v.barcode ?? "",
  taxable: (v) => (typeof v.taxable === "boolean" ? v.taxable : ""),
  variantTitle: (v) => v.title ?? "",
  inventoryQuantity: (v) => v.inventoryQuantity ?? "",
};

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

async function tryAdvisoryLock(client, lockKey, transactional = true) {
  if (transactional) {
    const rows = await client.$queryRaw`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
    `;
    return Boolean(rows?.[0]?.locked);
  }

  const rows = await client.$queryRaw`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

async function claimExportJob(exportJobId, shop, executionId, jobId, attempt) {
  return prisma.$transaction(async (tx) => {
    const locked = await tryAdvisoryLock(tx, `bulk-export:${shop}`, true);
    if (!locked) {
      return { state: "shop_busy", exportJob: null };
    }

    const currentJob = await tx.exportJob.findUnique({
      where: { id: exportJobId },
    });

    if (!currentJob) {
      throw new Error("Export job not found");
    }

    if (currentJob.shop !== shop) {
      throw new Error("Cross-shop export execution blocked");
    }

    if (executionId && executionId !== currentJob.id) {
      throw new Error("Export execution identity mismatch");
    }

    const executionState = String(currentJob.executionStateNormalized || "").toLowerCase();
    if (
      isTerminalExportExecutionState(executionState) ||
      ["COMPLETED", "FAILED", "CANCELLED", "PARTIAL"].includes(currentJob.executionStateNormalized || "") ||
      ["COMPLETED", "FAILED", "CANCELLED"].includes(currentJob.statusNormalized || "")
    ) {
      return { state: "terminal", exportJob: currentJob };
    }
    if (String(currentJob.executionState || "").toUpperCase() === "PAUSED") {
      return { state: "paused", exportJob: currentJob };
    }

    if (
      currentJob.executionStateNormalized === normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.FINALIZING,
      )
    ) {
      return { state: "finalizing", exportJob: currentJob };
    }

    if (
      currentJob.executionStateNormalized === normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.RUNNING,
      ) &&
      currentJob.fileUrl
    ) {
      return { state: "uploaded_pending_finalize", exportJob: currentJob };
    }

    const activeExport = await tx.exportJob.findFirst({
      where: {
        shop,
        statusNormalized: normalizeExportJobStatus("PROCESSING"),
        id: {
          not: exportJobId,
        },
      },
      select: { id: true },
    });

    if (activeExport) {
      return { state: "shop_busy", exportJob: currentJob };
    }

    const updated = await tx.exportJob.updateMany({
      where: {
        id: exportJobId,
        shop,
        statusNormalized: {
          in: [
            normalizeExportJobStatus("PENDING"),
            normalizeExportJobStatus("FAILED"),
          ],
        },
        executionStateNormalized: {
          in: [
            normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
            normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
            normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.FAILED),
          ],
        },
      },
      data: {
        status: "PROCESSING",
        statusNormalized: normalizeExportJobStatus("PROCESSING"),
        executionState: EXPORT_EXECUTION_STATES.RUNNING,
        executionStateNormalized: normalizeExportJobExecutionState(
          EXPORT_EXECUTION_STATES.RUNNING,
        ),
        startedAt: currentJob.startedAt || new Date(),
        error: null,
        failureStage: null,
      },
    });

    if (updated.count !== 1) {
      return { state: "not_claimed", exportJob: currentJob };
    }

    const claimedJob = await tx.exportJob.update({
      where: { id: exportJobId },
      data: {
        error: null,
        startedAt: currentJob.startedAt || new Date(),
      },
    });

    return {
      state: "claimed",
      exportJob: {
        ...claimedJob,
        dispatchJobId: jobId,
        dispatchAttempt: attempt,
      },
    };
  });
}

async function markExportRetryable(exportJobId, shop, error, attempt, details = {}) {
  const exportJob = await prisma.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: { error: true },
  });

  if (!exportJob) return;

  await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.RUNNING,
      ),
      fileUrl: null,
    },
    data: {
      status: "PENDING",
      statusNormalized: normalizeExportJobStatus("PENDING"),
      executionState: EXPORT_EXECUTION_STATES.QUEUED,
      executionStateNormalized: normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.QUEUED,
      ),
      failureStage: error.code || "retryable",
      error: appendSerializedExportError(
        exportJob.error,
        buildExportExecutionError({
          code: error.code || "retryable_export",
          stage: "worker_execution",
          message: error.message,
          retryable: true,
          details: {
            attempt,
            ...details,
          },
        }),
      ),
    },
  });
}

async function markExportFailure(exportJobId, shop, error, attempt, source, executionId) {
  const exportJob = await prisma.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: { error: true },
  });

  await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      executionStateNormalized: {
        in: [
          normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
          normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.FINALIZING),
        ],
      },
    },
    data: {
      status: "FAILED",
      statusNormalized: normalizeExportJobStatus("FAILED"),
      executionState: EXPORT_EXECUTION_STATES.FAILED,
      executionStateNormalized: normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.FAILED,
      ),
      failureStage: error.code || "export_worker",
      error: appendSerializedExportError(
        exportJob?.error,
        buildExportExecutionError({
          code: error.code || "bulk_export_worker_failure",
          stage: "export_worker",
          message: error.message,
          retryable: false,
          details: {
            stack: error.stack || null,
            attempt,
            source,
            executionId,
          },
        }),
      ),
      completedAt: new Date(),
    },
  }).catch(() => {});
}

async function finalizeExportSuccess(exportJob, fileUrl, totalRows) {
  const now = new Date();

  const updated = await prisma.exportJob.updateMany({
    where: {
      id: exportJob.id,
      shop: exportJob.shop,
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: {
        in: [
          normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
          normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.FINALIZING),
        ],
      },
    },
    data: {
      executionState: EXPORT_EXECUTION_STATES.COMPLETED,
      executionStateNormalized: normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.COMPLETED,
      ),
      status: "COMPLETED",
      statusNormalized: normalizeExportJobStatus("COMPLETED"),
      fileUrl,
      totalItems: totalRows,
      executionCursorOrdinal: null,
      durationMs: exportJob.startedAt
        ? Math.max(now.getTime() - new Date(exportJob.startedAt).getTime(), 0)
        : null,
      completedAt: now,
      failureStage: null,
    },
  });

  return updated.count === 1;
}

async function markFinalizing(exportJobId, shop) {
  const updated = await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.RUNNING,
      ),
    },
    data: {
      executionState: EXPORT_EXECUTION_STATES.FINALIZING,
      executionStateNormalized: normalizeExportJobExecutionState(
        EXPORT_EXECUTION_STATES.FINALIZING,
      ),
    },
  });

  return updated.count === 1;
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

      const claimResult = await claimExportJob(exportJobId, shop, executionId, job.id, attempt);
      const exportJob = claimResult.exportJob;

      if (!exportJob) {
        throw new Error("Export job not found");
      }

      if (["terminal", "paused", "not_claimed", "finalizing", "uploaded_pending_finalize"].includes(claimResult.state)) {
        return { skipped: true, reason: claimResult.state, shop, exportJobId };
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

const csvHeaders = ["id"];

if (selectedFields.some((f) => VARIANT_FIELD_RESOLVERS[f])) {
  csvHeaders.push("variant_id");
}

csvHeaders.push(...selectedFields);

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
        const operationState = await prisma.exportJob.findFirst({
          where: { id: exportJobId, shop },
          select: { cancelRequestedAt: true, pauseRequestedAt: true },
        });
        if (operationState?.cancelRequestedAt) {
          await prisma.exportJob.updateMany({
            where: {
              id: exportJobId,
              shop,
              statusNormalized: normalizeExportJobStatus("PROCESSING"),
              executionStateNormalized: normalizeExportJobExecutionState(
                EXPORT_EXECUTION_STATES.RUNNING,
              ),
            },
            data: {
              status: "CANCELLED",
              statusNormalized: normalizeExportJobStatus("CANCELLED"),
              executionState: EXPORT_EXECUTION_STATES.CANCELLED,
              executionStateNormalized: normalizeExportJobExecutionState(
                EXPORT_EXECUTION_STATES.CANCELLED,
              ),
              cancelledAt: new Date(),
              completedAt: new Date(),
            },
          });
          break;
        }
        if (operationState?.pauseRequestedAt) {
          await prisma.exportJob.updateMany({
            where: {
              id: exportJobId,
              shop,
              statusNormalized: normalizeExportJobStatus("PROCESSING"),
              executionStateNormalized: normalizeExportJobExecutionState(
                EXPORT_EXECUTION_STATES.RUNNING,
              ),
            },
            data: {
              status: "PENDING",
              statusNormalized: normalizeExportJobStatus("PENDING"),
              executionState: "PAUSED",
              executionStateNormalized: normalizeExportJobExecutionState(
                EXPORT_EXECUTION_STATES.QUEUED,
              ),
              pausedAt: new Date(),
              executionCursorOrdinal: cursorOrdinal,
            },
          });
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

        const products = await prisma.product.findMany({
          where: {
            shop,
            id: { in: productIds },
            ...(exportJob.targetMirrorBatchId
              ? { mirrorBatchId: exportJob.targetMirrorBatchId }
              : {}),
          },
          include: {
            variants: {
              orderBy: { id: "asc" },
            },
          },
        });

        const productMap = new Map(products.map((product) => [product.id, product]));

        for (const productId of productIds) {
          const product = productMap.get(productId);
          if (!product) continue;

          const variants = product.variants ?? [];

         if (!variants.length) {
  const row = { id: productId };

  if (csvHeaders.includes("variant_id")) {
    row.variant_id = "";
  }

  for (const field of selectedFields) {
    const productResolver = PRODUCT_FIELD_RESOLVERS[field];
    row[field] = productResolver ? productResolver(product) : "";
  }

  csvStream.write(row);
  totalRows += 1;
  continue;
}

         for (let index = 0; index < variants.length; index += 1) {
  const variant = variants[index];

  const row = {
    id: productId,
  };

  if (csvHeaders.includes("variant_id")) {
    row.variant_id = variant.id;
  }

  for (const field of selectedFields) {
    const productResolver = PRODUCT_FIELD_RESOLVERS[field];
    const variantResolver = VARIANT_FIELD_RESOLVERS[field];

    if (variantResolver) {
      row[field] = variantResolver(variant);
    } else if (productResolver) {
      row[field] = index === 0 ? productResolver(product) : "";
    } else {
      row[field] = "";
    }
  }

  csvStream.write(row);
  totalRows += 1;
}
        }

        cursorOrdinal = snapshotPage.lastOrdinal;
        await prisma.exportJob.update({
          where: { id: exportJobId },
          data: { executionCursorOrdinal: cursorOrdinal },
        });
        if (cursorOrdinal === null || cursorOrdinal === undefined) {
          break;
        }
      }

      const cancelled = await prisma.exportJob.findFirst({
        where: { id: exportJobId, shop },
        select: { statusNormalized: true, executionState: true },
      });
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
        return { skipped: true, reason: "cancelled_during_execution", shop, exportJobId };
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
        return { skipped: true, reason: "paused_during_execution", shop, exportJobId };
      }

      csvStream.end();

      await new Promise((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });

      const movedToFinalizing = await markFinalizing(exportJob.id, exportJob.shop);
      if (!movedToFinalizing) {
        throw new Error("Export could not transition to finalizing");
      }

      const fileUrl = await uploadCsvToCloudinary(
        filePath,
        exportJob.id,
        exportJob.filename,
      );

      await fs.promises.unlink(filePath).catch(() => {});
      filePath = null;

      const finalized = await finalizeExportSuccess(exportJob, fileUrl, totalRows);
      if (!finalized) {
        throw new Error("Export completion state could not be persisted safely");
      }

      await finalizeScheduledExportRunFromExportJob({
  exportJobId,
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

      return {
        success: true,
        exportJobId,
        totalRows,
        shop,
      };
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
        await markExportRetryable(exportJobId, shop, error, attempt, {
          source,
          worker: WORKER_NAME,
          queue: QUEUE_NAME,
          jobId: job?.id || null,
          executionId,
        }).catch(() => {});
      } else {
        await markExportFailure(exportJobId, shop, error, attempt, source, executionId);

        await finalizeScheduledExportRunFromExportJob({
  exportJobId,
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
