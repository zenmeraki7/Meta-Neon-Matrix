import { Worker } from "bullmq";
import fs from "fs";
import { promises as fsPromises } from "fs";
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
import { getJobAttempt, isRetryExhausted, recordRetryExhausted } from "../../utils/workerTelemetry.js";
import crypto from "crypto";
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
import { addBulkEditExecuteJob } from "../Queues/bulkEditExecuteJob.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { normalizeEditHistoryExecutionState } from "../../utils/normalizedStateUtils.js";

const QUEUE_NAME = process.env.IMPORT_EDIT_QUEUE || "importEdit";
const WORKER_NAME = "bulkImportEditWorker";

const normalizeBoolean = (value) =>
  value === true || value === "TRUE" || value === "true";
const normalizeNumber = (value) =>
  value !== undefined && value !== null && value !== "" ? Number(value) : undefined;

function extractProductOptions(existingProduct) {
  const options = [];
  const nameCols = ["option1Name", "option2Name", "option3Name"];
  const valueCols = ["option1Value", "option2Value", "option3Value"];

  for (let index = 0; index < 3; index += 1) {
    const name = existingProduct[nameCols[index]];
    if (!name) {
      continue;
    }

    const uniqueValues = [
      ...new Set(
        (existingProduct.variants || [])
          .map((variant) => variant[valueCols[index]])
          .filter(Boolean),
      ),
    ];

    options.push({
      id: `option${index + 1}`,
      name,
      values: uniqueValues,
    });
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
  if (!filePath) {
    return;
  }

  try {
    await fsPromises.unlink(filePath);
  } catch (_error) {}
}

async function claimImportHistoryForShop(historyId, shop) {
  const result = await db.editHistory.updateMany({
    where: {
      id: historyId,
      ...(shop ? { shop } : {}),
      status: "pending",
    },
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

function buildMappedProductRows(columnMappings, row, productMap) {
  const mapped = {};
  for (const [csvCol, field] of Object.entries(columnMappings || {})) {
    if (field && row[csvCol] !== undefined) {
      mapped[field] = row[csvCol];
    }
  }

  if (!mapped.id) {
    return;
  }

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
          tags: mapped.tags
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
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
      ...(mapped.compareAtPrice && {
        compareAtPrice: normalizeNumber(mapped.compareAtPrice),
      }),
      ...(mapped.sku && { sku: mapped.sku }),
      ...(mapped.barcode && { barcode: mapped.barcode }),
      ...(mapped.taxable !== undefined && {
        taxable: normalizeBoolean(mapped.taxable),
      }),
      ...(mapped.option1Value && { option1: mapped.option1Value }),
      ...(mapped.option2Value && { option2: mapped.option2Value }),
      ...(mapped.option3Value && { option3: mapped.option3Value }),
    });
  }
}

const bulkImportEditWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { historyId, shop, filePath, columnMappings, executionId = null } = job.data;
    const attempt = getJobAttempt(job);

    try {
      const history = await db.editHistory.findUnique({
        where: { id: historyId },
        select: {
          id: true,
          shop: true,
          status: true,
          executionIdentity: true,
        },
      });

      if (!history) {
        throw new Error("History document not found");
      }

      if (!shop || history.shop !== shop) {
        throw new Error("Cross-shop import execution blocked");
      }

      if (history.status === "processing" && job.attemptsMade > 0) {
        return {
          skipped: true,
          reason: "already_processing",
        };
      }

      const claimed = await claimImportHistoryForShop(historyId, shop);
      if (!claimed && history.status !== "processing") {
        return {
          skipped: true,
          reason: "already_claimed",
        };
      }

      await clearKeyCaches(`${history.shop}:fetchHistories`);

      const productMap = new Map();
      let totalRows = 0;
      const mirrorBatchId = await getActiveMirrorBatchId(history.shop, {
        purpose: "EXECUTE",
      });

      await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (row) => {
            totalRows += 1;
            buildMappedProductRows(columnMappings, row, productMap);
          })
          .on("end", resolve)
          .on("error", reject);
      });

      const productIds = [...productMap.keys()];
      const existingProducts = await db.product.findMany({
        where: {
          shop: history.shop,
          id: { in: productIds },
          mirrorBatchId,
        },
        include: { variants: true },
      });

      const existingById = existingProducts.reduce((accumulator, product) => {
        accumulator[product.id] = product;
        return accumulator;
      }, {});

      const changeRecords = [];
      const explicitTargets = [];
      const batchId = String(job.id);

      for (const { productSet } of productMap.values()) {
        const existingProduct = existingById[productSet.id];
        if (!existingProduct) {
          continue;
        }

       const existingProductForDiff = {
  ...existingProduct,
  descriptionHtml: existingProduct.descriptionHtml,
  seo: {
    title: existingProduct.seoTitle,
    description: existingProduct.seoDescription,
  },
  options: extractProductOptions(existingProduct),
  variants: mapExistingVariantsForDiff(existingProduct.variants),
};

        const productFieldChanges = diffProductFields(existingProductForDiff, productSet);
        const variantFieldChanges = diffVariants(
          existingProductForDiff.variants,
          productSet.variants,
        );

        if (!productFieldChanges.length && !variantFieldChanges.length) {
          continue;
        }

        const mutationRow = JSON.stringify(
          buildProductSetMutation({
            productSet,
            existingProduct: existingProductForDiff,
          }),
        );

        changeRecords.push({
          options: existingProductForDiff.options.map((option) => ({
            id: option.id,
            name: option.name,
            values: option.values,
          })),
          editHistoryId: historyId,
          targetType: variantFieldChanges.length ? "VARIANT" : "PRODUCT",
          targetIdentity: variantFieldChanges.length
            ? `PRODUCT:${productSet.id}:VARIANTS:${[...new Set(variantFieldChanges.map((item) => item?.variantId).filter(Boolean))].sort().join(",")}`
            : `PRODUCT:${productSet.id}`,
          productId: productSet.id,
          variantId: variantFieldChanges.length
            ? [...new Set(variantFieldChanges.map((item) => item?.variantId).filter(Boolean))].sort().join(",")
            : null,
          shop: history.shop,
          mirrorBatchId: existingProduct.mirrorBatchId || null,
          title: existingProduct.title,
          image: existingProduct.featuredImageUrl,
          scope: "mixed",
          batchId,
          beforeValues: {
            productFieldChanges,
            variantFieldChanges,
          },
          productFieldChanges,
          variantFieldChanges,
          status: "pending",
          csvMutationRow: mutationRow,
        });
        explicitTargets.push({
          targetType: "PRODUCT",
          targetIdentity: `PRODUCT:${productSet.id}`,
          productId: productSet.id,
          variantId: null,
          beforeValues: {
            productFieldChanges,
            variantFieldChanges,
          },
        });
      }

      if (!explicitTargets.length) {
      await db.editHistory.update({
        where: { id: historyId },
        data: {
          totalRows,
          totalItems: 0,
          status: "failed",
          executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
          error: {
            message: "No valid changes were detected in the import file",
          },
          },
        });
        await removeLocalFile(filePath);
        return {
          skipped: true,
          reason: "no_valid_changes",
        };
      }

      if (changeRecords.length) {
        await db.changeRecord.createMany({
          data: changeRecords.map((record) => {
            const {
              csvMutationRow,
              options,
              ...rest
            } = record;
            return {
              ...rest,
              options: {
                csvMutationRow,
                csvImport: true,
                productOptions: options,
              },
            };
          }),
        });
      }

      const filterHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify(
            explicitTargets.map((target) => target.targetIdentity).sort(),
          ),
        )
        .digest("hex");

      const frozenCount = await freezeExplicitTargetSnapshot({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        mirrorBatchId,
        filterHash,
        targetGranularity: "PRODUCT",
        source: "CSV_IMPORT",
        targets: explicitTargets,
      });

      const snapshotChecksum = await computeTargetSnapshotChecksum({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        mirrorBatchId,
      });

      await db.editHistory.update({
        where: { id: historyId },
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
        where: { editHistoryId: historyId },
        data: { totalRows },
      });

      await addBulkEditExecuteJob({
        historyId,
        shop: history.shop,
        source: "csv_import_pipeline",
        executionId: history.executionIdentity || historyId,
      });

      await clearKeyCaches(`${history.shop}:fetchHistories`);
      await removeLocalFile(filePath);

      return {
        success: true,
        historyId,
        totalRows,
        totalItems: frozenCount,
      };
    } catch (error) {
      logger.error("Bulk import edit worker failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        jobId: job.id,
        shop,
        historyId,
        executionId,
        attempt,
        message: error.message,
      });

      await removeLocalFile(filePath);

      await db.editHistory.updateMany({
        where: { id: historyId, ...(shop ? { shop } : {}) },
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
              details: {
                stack: error.stack || null,
                failedAt: new Date().toISOString(),
              },
            }),
          ),
        },
      });

      await logWorkerError({
        shop,
        err: error,
        source: "bulkImportEditWorker",
        metadata: {
          queue: QUEUE_NAME,
          worker: WORKER_NAME,
          jobId: job?.id || null,
          historyId,
          executionId,
          attempt,
        },
      });

      throw error;
    }
  },
  { connection, concurrency: 1 },
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
    message: error.message,
  });
});

bulkImportEditWorker.on("failed", async (job) => {
  if (isRetryExhausted(job)) {
    await recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      entityType: "editHistory",
      entityId: job?.data?.historyId,
      executionId: job?.data?.executionId || null,
      message: "Bulk import edit worker exhausted retries",
    });
  }
});

export default bulkImportEditWorker;

