import { UnrecoverableError, Worker } from "bullmq";
import crypto from "crypto";
import fs from "fs";
import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";
import csv from "csv-parser";
import { connection } from "../../config/redis.js";
import logger from "../../utils/loggerUtils.js";
import {
  buildProductSetMutation,
  diffProductFields,
  diffVariants,
} from "../../utils/importEditUtils.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { db } from "../../repositories/repositoryDb.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import {
  getJobAttempt,
  isRetryExhausted,
  recordRetryExhausted,
  willExhaustRetryFromProcessor,
} from "../../utils/workerTelemetry.js";
import {
  BULK_EDIT_EXECUTION_STATES,
  appendExecutionError,
  buildExecutionError,
} from "../../services/bulkEditExecutionStateService.js";
import {
  computeTargetSnapshotChecksum,
  freezeExplicitTargetSnapshot,
  getActiveMirrorBatchId,
} from "../../services/productService/productTargetingService.js";
import { addBulkImportExecuteJob } from "../Queues/bulkImportExecuteJob.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { normalizeEditHistoryExecutionState } from "../../utils/normalizedStateUtils.js";
import { bulkImportEditDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const QUEUE_NAME = process.env.IMPORT_EDIT_QUEUE || "importEdit";
const DLQ_NAME = process.env.IMPORT_EDIT_DLQ_QUEUE || "importEdit-dlq";
const WORKER_NAME = "bulkImportEditWorker";
const PRODUCT_CHUNK_SIZE = Number(process.env.IMPORT_EDIT_PRODUCT_CHUNK_SIZE || 500);
const SNAPSHOT_CHUNK_SIZE = Number(process.env.IMPORT_EDIT_SNAPSHOT_CHUNK_SIZE || 500);
const UPLOAD_BASE = path.resolve(process.env.CSV_UPLOAD_DIR || process.env.UPLOAD_DIR || os.tmpdir());
const TERMINAL_HISTORY_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

const normalizeBoolean = (value) =>
  value === true || value === "TRUE" || value === "true";
const normalizeNumber = (value) =>
  value !== undefined && value !== null && value !== "" ? Number(value) : undefined;

function nonRetryableError(message) {
  const error = new Error(message);
  error.nonRetryable = true;
  return error;
}

function assertSafeFilePath(filePath, expectedFilePath) {
  if (!filePath) {
    throw nonRetryableError("FILE_PATH_REQUIRED");
  }

  const resolved = path.resolve(filePath);
  const relative = path.relative(UPLOAD_BASE, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw nonRetryableError("UNSAFE_FILE_PATH");
  }
  if (path.extname(resolved).toLowerCase() !== ".csv") {
    throw nonRetryableError("INVALID_IMPORT_FILE_TYPE");
  }
  if (!expectedFilePath || path.resolve(expectedFilePath) !== resolved) {
    throw nonRetryableError("IMPORT_FILE_OWNERSHIP_MISMATCH");
  }
  return resolved;
}

function extractProductOptions(existingProduct) {
  const options = [];
  const nameCols = ["option1Name", "option2Name", "option3Name"];
  const valueCols = ["option1Value", "option2Value", "option3Value"];

  for (let index = 0; index < 3; index += 1) {
    const name = existingProduct[nameCols[index]];
    if (!name) continue;
    const uniqueValues = [
      ...new Set(
        (existingProduct.variants || [])
          .map((variant) => variant[valueCols[index]])
          .filter(Boolean),
      ),
    ];
    options.push({ id: `option${index + 1}`, name, values: uniqueValues });
  }
  return options;
}

function mapExistingVariantsForDiff(existingVariants) {
  return (existingVariants || []).map((variant) => ({
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    barcode: variant.barcode,
    price: variant.price,
    compareAtPrice: variant.compareAtPrice,
    inventoryQuantity: variant.inventoryQuantity,
    inventoryPolicy: variant.inventoryPolicy,
    taxable: variant.taxable,
    taxCode: variant.taxCode,
    cost: variant.cost,
    countryOfOrigin: variant.countryOfOrigin,
    hsTariffCode: variant.hsTariffCode,
    weight: variant.weight,
    weightUnit: variant.weightUnit,
    option1: variant.option1Value,
    option2: variant.option2Value,
    option3: variant.option3Value,
    selectedOptions: Array.isArray(variant.selectedOptionsJson)
      ? variant.selectedOptionsJson
      : [],
    tracked: variant.tracked,
    physicalProduct: variant.physicalProduct,
    profitMargin: variant.profitMargin,
  }));
}

async function removeLocalFile(filePath) {
  if (!filePath) return;
  await fsPromises.unlink(filePath).catch(() => {});
}

async function claimImportHistoryForShop(historyId, shop) {
  const result = await db.editHistory.updateMany({
    where: { id: historyId, shop, status: "pending" },
    data: {
      status: "processing",
      executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      ),
    },
  });
  return result.count === 1;
}

function mapCsvRow(columnMappings, row) {
  const mapped = {};
  for (const [csvCol, field] of Object.entries(columnMappings || {})) {
    if (field && row[csvCol] !== undefined) mapped[field] = row[csvCol];
  }
  return mapped;
}

function addMappedProductRow(mapped, productMap) {
  if (!mapped.id) return null;
  const productId = mapped.id;
  if (!productMap.has(productId)) {
    productMap.set(productId, {
      productSet: {
        id: productId,
        ...(mapped.title && { title: mapped.title }),
        ...(mapped.vendor && { vendor: mapped.vendor }),
        ...(mapped.status && { status: mapped.status.toUpperCase() }),
        ...(mapped.description && { descriptionHtml: mapped.description }),
        ...(mapped.productType && { productType: mapped.productType }),
        ...(mapped.handle && { handle: mapped.handle }),
        ...(mapped.tags && {
          tags: mapped.tags.split(",").map((value) => value.trim()).filter(Boolean),
        }),
        ...((mapped.metaTitle || mapped.metaDescription) && {
          seo: {
            ...(mapped.metaTitle && { title: mapped.metaTitle }),
            ...(mapped.metaDescription && { description: mapped.metaDescription }),
          },
        }),
        options: [],
        variants: [],
      },
    });
    const product = productMap.get(productId).productSet;
    if (mapped.option1Name) product.options.push({ name: mapped.option1Name });
    if (mapped.option2Name) product.options.push({ name: mapped.option2Name });
    if (mapped.option3Name) product.options.push({ name: mapped.option3Name });
  }

  if (mapped.variant_id) {
    productMap.get(productId).productSet.variants.push({
      id: mapped.variant_id,
      ...(mapped.price && { price: normalizeNumber(mapped.price) }),
      ...(mapped.compareAtPrice && { compareAtPrice: normalizeNumber(mapped.compareAtPrice) }),
      ...(mapped.sku && { sku: mapped.sku }),
      ...(mapped.barcode && { barcode: mapped.barcode }),
      ...(mapped.taxable !== undefined && { taxable: normalizeBoolean(mapped.taxable) }),
      ...(mapped.option1Value && { option1: mapped.option1Value }),
      ...(mapped.option2Value && { option2: mapped.option2Value }),
      ...(mapped.option3Value && { option3: mapped.option3Value }),
    });
  }
  return productId;
}

const productDiffSelect = {
  id: true,
  mirrorBatchId: true,
  title: true,
  vendor: true,
  status: true,
  descriptionHtml: true,
  productType: true,
  handle: true,
  tags: true,
  seoTitle: true,
  seoDescription: true,
  featuredImageUrl: true,
  option1Name: true,
  option2Name: true,
  option3Name: true,
  variants: {
    select: {
      id: true,
      title: true,
      sku: true,
      barcode: true,
      price: true,
      compareAtPrice: true,
      inventoryQuantity: true,
      inventoryPolicy: true,
      taxable: true,
      taxCode: true,
      cost: true,
      countryOfOrigin: true,
      hsTariffCode: true,
      weight: true,
      weightUnit: true,
      option1Value: true,
      option2Value: true,
      option3Value: true,
      selectedOptionsJson: true,
      tracked: true,
      physicalProduct: true,
      profitMargin: true,
    },
  },
};

async function processProductChunk({ productMap, history, mirrorBatchId, batchId }) {
  if (!productMap.size) return 0;
  const productIds = [...productMap.keys()];
  const existingProducts = await db.product.findMany({
    where: { shop: history.shop, id: { in: productIds }, mirrorBatchId },
    select: productDiffSelect,
  });
  const existingById = new Map(existingProducts.map((product) => [product.id, product]));
  const changeRecords = [];

  for (const { productSet } of productMap.values()) {
    const existingProduct = existingById.get(productSet.id);
    if (!existingProduct) continue;
    const existingProductForDiff = {
      ...existingProduct,
      seo: { title: existingProduct.seoTitle, description: existingProduct.seoDescription },
      options: extractProductOptions(existingProduct),
      variants: mapExistingVariantsForDiff(existingProduct.variants),
    };
    const productFieldChanges = diffProductFields(existingProductForDiff, productSet);
    const variantFieldChanges = diffVariants(existingProductForDiff.variants, productSet.variants);
    if (!productFieldChanges.length && !variantFieldChanges.length) continue;
    const variantIds = [...new Set(
      variantFieldChanges.map((item) => item?.variantId).filter(Boolean),
    )].sort();
    const csvMutationRow = JSON.stringify(
      buildProductSetMutation({ productSet, existingProduct: existingProductForDiff }),
    );
    changeRecords.push({
      editHistoryId: history.id,
      targetType: variantFieldChanges.length ? "VARIANT" : "PRODUCT",
      targetIdentity: variantFieldChanges.length
        ? `PRODUCT:${productSet.id}:VARIANTS:${variantIds.join(",")}`
        : `PRODUCT:${productSet.id}`,
      productId: productSet.id,
      variantId: variantFieldChanges.length ? variantIds.join(",") : null,
      shop: history.shop,
      mirrorBatchId: existingProduct.mirrorBatchId || null,
      title: existingProduct.title,
      image: existingProduct.featuredImageUrl,
      scope: "mixed",
      batchId,
      beforeValues: { productFieldChanges, variantFieldChanges },
      productFieldChanges,
      variantFieldChanges,
      status: "PENDING",
      options: {
        csvMutationRow,
        csvImport: true,
        productOptions: existingProductForDiff.options,
      },
    });
  }

  if (changeRecords.length) {
    await db.changeRecord.createMany({ data: changeRecords, skipDuplicates: true });
  }
  return changeRecords.length;
}

async function freezeChangeRecordTargets({ history, mirrorBatchId, batchId }) {
  const where = { shop: history.shop, editHistoryId: history.id, batchId };
  const hash = crypto.createHash("sha256");
  hash.update("[");
  let offset = 0;
  let firstIdentity = true;

  while (true) {
    const rows = await db.changeRecord.findMany({
      where,
      select: { productId: true },
      orderBy: [{ productId: "asc" }, { id: "asc" }],
      skip: offset,
      take: SNAPSHOT_CHUNK_SIZE,
    });
    for (const row of rows) {
      if (!firstIdentity) hash.update(",");
      hash.update(JSON.stringify(`PRODUCT:${row.productId}`));
      firstIdentity = false;
    }
    offset += rows.length;
    if (rows.length < SNAPSHOT_CHUNK_SIZE) break;
  }
  hash.update("]");
  const filterHash = hash.digest("hex");

  offset = 0;
  let frozenCount = 0;
  while (true) {
    const rows = await db.changeRecord.findMany({
      where,
      select: { productId: true, beforeValues: true },
      orderBy: [{ productId: "asc" }, { id: "asc" }],
      skip: offset,
      take: SNAPSHOT_CHUNK_SIZE,
    });
    if (!rows.length) break;
    frozenCount += await freezeExplicitTargetSnapshot({
      ownerType: "EDIT_HISTORY",
      ownerId: history.id,
      shop: history.shop,
      mirrorBatchId,
      filterHash,
      targetGranularity: "PRODUCT",
      source: "CSV_IMPORT",
      replaceExisting: offset === 0,
      ordinalOffset: offset,
      targets: rows.map((row) => ({
        targetType: "PRODUCT",
        targetIdentity: `PRODUCT:${row.productId}`,
        productId: row.productId,
        variantId: null,
        beforeValues: row.beforeValues,
      })),
    });
    offset += rows.length;
    if (rows.length < SNAPSHOT_CHUNK_SIZE) break;
  }
  return { filterHash, frozenCount };
}

const bulkImportEditWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { historyId, shop, filePath, columnMappings, executionId = null } = job.data || {};
    const attempt = getJobAttempt(job);
    let safeFilePath = null;
    let cleanupFile = true;

    try {
      if (!historyId || !shop || !filePath) {
        throw nonRetryableError("bulk import edit job requires historyId, shop, and filePath");
      }
      const [history, spreadsheetFile] = await Promise.all([
        db.editHistory.findFirst({
          where: { id: historyId, shop },
          select: { id: true, shop: true, status: true, executionIdentity: true },
        }),
        db.spreadsheetFile.findFirst({
          where: { editHistoryId: historyId, shop },
          select: { fileUrl: true },
          orderBy: { createdAt: "desc" },
        }),
      ]);
      if (!history) throw nonRetryableError("History document not found");
      safeFilePath = assertSafeFilePath(filePath, spreadsheetFile?.fileUrl);

      const status = String(history.status || "").toLowerCase();
      if (TERMINAL_HISTORY_STATUSES.has(status)) {
        return { skipped: true, reason: `already_terminal:${status}` };
      }
      const claimed = await claimImportHistoryForShop(historyId, shop);
      if (!claimed && !(status === "processing" && job.attemptsMade > 0)) {
        cleanupFile = false;
        throw new Error("IMPORT_HISTORY_CLAIM_CONFLICT");
      }

      await clearKeyCaches(`${history.shop}:fetchHistories`);
      const mirrorBatchId = await getActiveMirrorBatchId(history.shop, { purpose: "EXECUTE" });
      const batchId = String(executionId || history.executionIdentity || historyId);
      let productMap = new Map();
      let totalRows = 0;
      let changeCount = 0;

      const csvStream = fs.createReadStream(safeFilePath).pipe(csv());
      for await (const row of csvStream) {
        totalRows += 1;
        const mapped = mapCsvRow(columnMappings, row);
        const productId = mapped.id || null;
        if (productId && !productMap.has(productId) && productMap.size >= PRODUCT_CHUNK_SIZE) {
          changeCount += await processProductChunk({
            productMap,
            history,
            mirrorBatchId,
            batchId,
          });
          productMap = new Map();
        }
        addMappedProductRow(mapped, productMap);
      }
      changeCount += await processProductChunk({ productMap, history, mirrorBatchId, batchId });

      if (!changeCount) {
        const existingCount = await db.changeRecord.count({
          where: { shop: history.shop, editHistoryId: historyId, batchId },
        });
        if (!existingCount) {
          await db.editHistory.updateMany({
            where: { id: historyId, shop: history.shop },
            data: {
              totalRows,
              totalItems: 0,
              status: "failed",
              executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
              error: { message: "No valid changes were detected in the import file" },
            },
          });
          return { skipped: true, reason: "no_valid_changes" };
        }
      }

      const { filterHash, frozenCount } = await freezeChangeRecordTargets({
        history,
        mirrorBatchId,
        batchId,
      });
      const snapshotChecksum = await computeTargetSnapshotChecksum({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        mirrorBatchId,
      });
      await db.editHistory.updateMany({
        where: { id: historyId, shop: history.shop },
        data: {
          totalRows,
          totalItems: frozenCount,
          targetSnapshotCount: frozenCount,
          targetMirrorBatchId: mirrorBatchId,
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          ),
          batch: {
            csvImport: true,
            targetGranularity: "PRODUCT",
            lastProductId: null,
            hasMore: frozenCount > 0,
            size: 75,
            previewCount: frozenCount,
            currentBatchTargetCount: 0,
            queuedAt: new Date().toISOString(),
            filterParams: [],
            filterAst: null,
            filterHash,
            freezeSource: "CSV_IMPORT",
          },
          targetingSnapshotMeta: {
            shop: history.shop,
            source: "CSV_IMPORT",
            mirrorBatchId,
            targetCount: frozenCount,
            filterHash,
            snapshotChecksum,
            targetGranularity: "PRODUCT",
            resolvedAt: new Date(),
          },
        },
      });
      await db.spreadsheetFile.updateMany({
        where: { editHistoryId: historyId, shop: history.shop },
        data: { totalRows },
      });
      await addBulkImportExecuteJob({
        historyId,
        shop: history.shop,
        executionId: history.executionIdentity || historyId,
      });
      await clearKeyCaches(`${history.shop}:fetchHistories`);
      return { success: true, historyId, totalRows, totalItems: frozenCount };
    } catch (error) {
      const terminalFailure = error?.nonRetryable || willExhaustRetryFromProcessor(job);
      cleanupFile = cleanupFile && terminalFailure;
      logger.error("Bulk import edit worker failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job.id,
        shop,
        historyId,
        executionId,
        attempt,
        retryable: !terminalFailure,
        message: error.message,
      });
      if (terminalFailure && historyId && shop) {
        await db.editHistory.updateMany({
          where: { id: historyId, shop },
          data: {
            status: "failed",
            executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
            error: appendExecutionError(
              null,
              buildExecutionError({
                code: "bulk_import_worker_failure",
                stage: "queue_execution",
                message: error.message,
                retryable: false,
                details: { stack: error.stack || null, failedAt: new Date().toISOString() },
              }),
            ),
          },
        });
      }
      await logWorkerError({
        shop,
        err: error,
        source: WORKER_NAME,
        metadata: { queue: QUEUE_NAME, worker: WORKER_NAME, jobId: job?.id || null, historyId, executionId, attempt },
      });
      if (error?.nonRetryable) throw new UnrecoverableError(error.message);
      throw error;
    } finally {
      if (cleanupFile) await removeLocalFile(safeFilePath);
    }
  },
  {
    connection,
    concurrency: 1,
    lockDuration: Number(process.env.IMPORT_EDIT_LOCK_DURATION_MS || 900_000),
    stalledInterval: Number(process.env.IMPORT_EDIT_STALLED_INTERVAL_MS || 60_000),
    maxStalledCount: Number(process.env.IMPORT_EDIT_MAX_STALLED_COUNT || 1),
  },
);

bulkImportEditWorker.on("failed", (job, error) => {
  logger.error("Bulk import worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    executionId: job?.data?.executionId || null,
    attempt: getJobAttempt(job),
    message: error?.message,
  });
  if (isRetryExhausted(job) || error?.name === "UnrecoverableError") {
    void recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      entityType: "editHistory",
      entityId: job?.data?.historyId,
      executionId: job?.data?.executionId || null,
      message: "Bulk import edit worker exhausted retries",
    }).catch((telemetryError) => {
      logger.error("Bulk import retry exhaustion telemetry failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: telemetryError?.message,
      });
    });
    void bulkImportEditDlqQueue.add(
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
      logger.error("Bulk import DLQ enqueue failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

bulkImportEditWorker.on("completed", (job, result) => {
  logger.info("Bulk import worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

bulkImportEditWorker.on("stalled", (jobId) => {
  logger.warn("Bulk import worker stalled", { worker: WORKER_NAME, queue: QUEUE_NAME, jobId });
});

bulkImportEditWorker.on("error", (error) => {
  logger.error("Bulk import worker runtime error", {
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
    await bulkImportEditWorker.close();
  } catch (error) {
    logger.error("Bulk import worker shutdown failed", {
      worker: WORKER_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkImportEditWorker;
