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
  buildPlannedUndoState,
  buildExecutionError,
} from "../../services/bulkEditExecutionStateService.js";
import {
  computeTargetSetHash,
  freezeExplicitTargetSet,
  getActiveMirrorBatchId,
} from "../../services/productService/productTargetingService.js";
import { finalizeFrozenSnapshotSet } from "../../repositories/targetSnapshotSetRepository.js";
import { addBulkEditExecuteJob } from "../Queues/bulkEditExecuteJob.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { buildExecutionPlanForEdit } from "../../services/bulkEdit/bulkEditPlanUtils.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { isAllowedImportFieldKey } from "../../services/productImport/importFieldRegistry.js";
import { QUEUE_NAMES } from "../../queues/queueNames.js";
import { immutableObjectStorage } from "../../services/storage/immutableObjectStorage.js";
import { upsertAuthoritativeChangeRecords } from "../../services/changeRecordIdentityService.js";

const QUEUE_NAME = QUEUE_NAMES.CSV_IMPORT_PREPARE;
const WORKER_NAME = "bulkImportEditWorker";
const PRODUCT_GID_RE = /^gid:\/\/shopify\/Product\/\d+$/;
const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

function buildCsvImportExecutionPlan({ historyId, shop, targetCount }) {
  return buildExecutionPlanForEdit({
    operationKey: "CSV_IMPORT_SET",
    operationId: historyId,
    shop,
    planType: "CSV_IMPORT",
    rules: [{ field: "mixed" }],
    targetGranularity: "PRODUCT",
    targetCount,
    shopPlanLimits: { batchSize: 250 },
  });
}

const normalizeBoolean = (value) =>
  value === true || value === "TRUE" || value === "true";
const normalizeNumber = (value) =>
  value !== undefined && value !== null && value !== "" ? Number(value) : undefined;

function assertImportJobPayload(job) {
  const payload = job?.data || {};
  const historyId = String(payload.historyId || "").trim();
  const shop = String(payload.shop || "").trim();
  const executionId = String(payload.executionId || "").trim() || null;

  if (!historyId || !shop) {
    throw new Error("CSV_IMPORT_JOB_PAYLOAD_INVALID");
  }

  return {
    historyId,
    shop,
    executionId,
  };
}

function addValidationError(errors, rowNumber, code, message) {
  errors.push({
    rowNumber,
    code,
    message,
  });
}

function buildCsvCreateProductId({ rowNumber, mapped }) {
  const seed = JSON.stringify({
    rowNumber,
    title: mapped.title || null,
    handle: mapped.handle || null,
    vendor: mapped.vendor || null,
    sku: mapped.sku || null,
  });
  return `CSV_CREATE:${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

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
    profitMarginRatio: variant.profitMarginRatio,
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

export async function claimImportHistory({
  historyId,
  shop,
  ownerId,
  leaseMs = 5 * 60 * 1000,
  dbClient = null,
}) {
  const database = dbClient || db;
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);

  const claimed = await database.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      OR: [
        {
          executionStateNormalized: "PLANNED",
          statusNormalized: "PENDING",
        },
        {
          executionStateNormalized: "TARGET_FREEZING",
          executionLeaseUntil: { lt: now },
        },
        {
          executionStateNormalized: "PLANNED",
          executionLeaseUntil: { lt: now },
        },
      ],
    },
    data: {
      status: "processing",
      statusNormalized: normalizeEditHistoryStatus("processing"),
      executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      ),
      executionOwnerId: ownerId,
      executionLeaseUntil: leaseUntil,
      executionHeartbeatAt: now,
      stateVersion: { increment: 1 },
    },
  });

  return claimed.count === 1;
}

function buildMappedProductRows(
  columnMappings,
  row,
  productMap,
  { rowNumber, seenIdentities, validationErrors },
) {
  const mapped = {};
  for (const [csvCol, field] of Object.entries(columnMappings || {})) {
    if (field && row[csvCol] !== undefined) {
      mapped[field] = row[csvCol];
    }
  }

  const productId = String(mapped.id || "").trim();
  const variantId = String(mapped.variant_id || "").trim();
  const isCreateRow = !productId;

  if (isCreateRow && !String(mapped.title || "").trim()) {
    addValidationError(
      validationErrors,
      rowNumber,
      "PRODUCT_TITLE_REQUIRED",
      "Title is required when importing a new product without Product ID",
    );
    return;
  }

  if (productId && !PRODUCT_GID_RE.test(productId)) {
    addValidationError(
      validationErrors,
      rowNumber,
      "INVALID_PRODUCT_ID",
      "Product ID must be a Shopify Product GID",
    );
    return;
  }

  if (isCreateRow && variantId) {
    addValidationError(
      validationErrors,
      rowNumber,
      "VARIANT_ID_WITHOUT_PRODUCT_ID",
      "Variant ID can only be used when Product ID is mapped for an existing product update",
    );
    return;
  }

  if (!isCreateRow && variantId && !VARIANT_GID_RE.test(variantId)) {
    addValidationError(
      validationErrors,
      rowNumber,
      "INVALID_VARIANT_ID",
      "Variant ID must be a Shopify ProductVariant GID",
    );
    return;
  }

  const resolvedProductId = productId || buildCsvCreateProductId({ rowNumber, mapped });
  const identityKey = variantId ? `${resolvedProductId}:${variantId}` : `${resolvedProductId}:PRODUCT`;
  if (seenIdentities.has(identityKey)) {
    addValidationError(
      validationErrors,
      rowNumber,
      "DUPLICATE_IMPORT_IDENTITY",
      "Duplicate Product ID / Variant ID rows are not allowed",
    );
    return;
  }
  seenIdentities.add(identityKey);

  if (!productMap.has(resolvedProductId)) {
    productMap.set(resolvedProductId, {
      isCreate: isCreateRow,
      syntheticProductId: isCreateRow ? resolvedProductId : null,
      productSet: {
        ...(!isCreateRow && { id: resolvedProductId }),
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

    const product = productMap.get(resolvedProductId).productSet;
    if (mapped.option1Name) product.options.push({ name: mapped.option1Name });
    if (mapped.option2Name) product.options.push({ name: mapped.option2Name });
    if (mapped.option3Name) product.options.push({ name: mapped.option3Name });
  }

  if (variantId) {
    productMap.get(resolvedProductId).productSet.variants.push({
      id: variantId,
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

export function isImportValidationError(error) {
  if (!error) return false;
  const msg = String(error.message || "").toUpperCase();
  const code = String(error.code || "").toUpperCase();
  return (
    code.includes("VALIDATION") ||
    code.includes("INVALID") ||
    code.includes("FORMAT") ||
    msg.includes("VALIDATION") ||
    msg.includes("INVALID") ||
    msg.includes("CSV_IMPORT_JOB_PAYLOAD_INVALID") ||
    msg.includes("MAPPING") ||
    msg.includes("HEADER")
  );
}

export async function markImportRetryWait(historyId, shop, error, delayMs = 60_000) {
  const nextAttemptAt = new Date(Date.now() + delayMs);
  await db.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      status: "pending",
      statusNormalized: normalizeEditHistoryStatus("pending"),
      executionOwnerId: null,
      executionLeaseUntil: null,
      nextAttemptAt,
      error: buildExecutionError({
        code: "import_transient_failure",
        stage: "queue_execution",
        message: error.message,
        retryable: true,
      }),
    },
  });
}

const bulkImportEditWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const {
      historyId,
      shop,
      filePath,
      columnMappings,
      executionId = null,
    } = assertImportJobPayload(job);
    const attempt = getJobAttempt(job);

    try {
      const history = await db.editHistory.findFirst({
        where: { id: historyId, shop },
        include: {
          spreadsheetFile: {
            select: {
              storageKey: true,
              contentSha256: true,
              columnMappings: true,
              downloadUrl: true,
            },
          },
        },
      });

      if (!history || !history.spreadsheetFile) {
        throw new Error("History document or spreadsheet file not found");
      }

      if (!shop || history.shop !== shop) {
        throw new Error("Cross-shop import execution blocked");
      }

      const storageKey = history.spreadsheetFile.storageKey || history.spreadsheetFile.downloadUrl;
      const contentSha256 = history.spreadsheetFile.contentSha256;
      const columnMappings = history.spreadsheetFile.columnMappings;

      if (!storageKey || !columnMappings) {
        throw new Error("CSV_IMPORT_FILE_METADATA_INVALID");
      }

      if (contentSha256) {
        await immutableObjectStorage.verifyStreamSha256(storageKey, contentSha256);
      }

      const ownerId = `csv-import:${job.id}:${crypto.randomUUID()}`;
      const IMPORT_LEASE_MS = 5 * 60 * 1000;

      const claimed = await claimImportHistory({
        historyId,
        shop: history.shop,
        ownerId,
        leaseMs: IMPORT_LEASE_MS,
      });

      if (!claimed) {
        return {
          skipped: true,
          reason: "not_claimed",
        };
      }

      await clearKeyCaches(`${history.shop}:fetchHistories`);

      const productMap = new Map();
      const seenIdentities = new Set();
      const validationErrors = [];
      let totalRows = 0;
      const mirrorBatchId = await getActiveMirrorBatchId(history.shop, {
        purpose: "CSV_IMPORT_PREPARE",
      });

      await new Promise((resolve, reject) => {
        const stream = immutableObjectStorage.openReadStream(storageKey);
        stream
          .pipe(csv())
          .on("data", (row) => {
            totalRows += 1;
            buildMappedProductRows(columnMappings, row, productMap, {
              rowNumber: totalRows,
              seenIdentities,
              validationErrors,
            });
          })
          .on("end", resolve)
          .on("error", reject);
      });

      if (validationErrors.length) {
        const error = new Error("CSV_IMPORT_VALIDATION_FAILED");
        error.details = validationErrors.slice(0, 20);
        throw error;
      }

      const productIds = [...productMap.entries()]
        .filter(([, value]) => !value.isCreate)
        .map(([productId]) => productId);
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

      const missingProductIds = productIds.filter((productId) => !existingById[productId]);
      if (missingProductIds.length) {
        const error = new Error("CSV_IMPORT_PRODUCT_NOT_FOUND_IN_SHOP");
        error.details = {
          productIds: missingProductIds.slice(0, 20),
          count: missingProductIds.length,
        };
        throw error;
      }

      for (const { productSet, isCreate } of productMap.values()) {
        if (isCreate) {
          continue;
        }
        const existingProduct = existingById[productSet.id];
        const variantIdsForProduct = new Set(
          (existingProduct?.variants || []).map((variant) => variant.id),
        );
        const invalidVariantIds = (productSet.variants || [])
          .map((variant) => variant.id)
          .filter((variantId) => !variantIdsForProduct.has(variantId));
        if (invalidVariantIds.length) {
          const error = new Error("CSV_IMPORT_VARIANT_NOT_IN_PRODUCT");
          error.details = {
            productId: productSet.id,
            variantIds: invalidVariantIds.slice(0, 20),
            count: invalidVariantIds.length,
          };
          throw error;
        }
      }

      const changeRecords = [];
      const explicitTargets = [];
      const batchId = String(job.id);
      const containsProductCreates = [...productMap.values()].some((value) => value.isCreate);

      for (const { productSet, isCreate, syntheticProductId } of productMap.values()) {
        const effectiveProductId = isCreate ? syntheticProductId : productSet.id;
        const existingProduct = isCreate ? null : existingById[productSet.id];
        if (!isCreate && !existingProduct) {
          continue;
        }

        const existingProductForDiff = isCreate
          ? {
              id: effectiveProductId,
              title: null,
              descriptionHtml: null,
              vendor: null,
              productType: null,
              handle: null,
              status: null,
              tags: [],
              seo: { title: null, description: null },
              options: productSet.options || [],
              variants: [],
            }
          : {
              ...existingProduct,
              descriptionHtml: existingProduct.descriptionHtml,
              seo: {
                title: existingProduct.seoTitle,
                description: existingProduct.seoDescription,
              },
              options: extractProductOptions(existingProduct),
              variants: mapExistingVariantsForDiff(existingProduct.variants),
            };

        const productFieldChanges = isCreate
          ? Object.entries({
              title: productSet.title,
              vendor: productSet.vendor,
              status: productSet.status,
              productType: productSet.productType,
              handle: productSet.handle,
              description: productSet.descriptionHtml,
              tags: Array.isArray(productSet.tags) ? productSet.tags.join(", ") : undefined,
            })
              .filter(([, value]) => value !== undefined && value !== null && value !== "")
              .map(([field, newValue]) => ({
                field,
                oldValue: null,
                newValue,
                revertValue: null,
              }))
          : diffProductFields(existingProductForDiff, productSet);
        const variantFieldChanges = isCreate
          ? []
          : diffVariants(
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
          targetResourceType: variantFieldChanges.length ? "VARIANT" : "PRODUCT",
          targetIdentity: variantFieldChanges.length
            ? `PRODUCT:${productSet.id}:VARIANTS:${[...new Set(variantFieldChanges.map((item) => item?.variantId).filter(Boolean))].sort().join(",")}`
            : `PRODUCT:${effectiveProductId}`,
          productId: effectiveProductId,
          variantId: variantFieldChanges.length
            ? [...new Set(variantFieldChanges.map((item) => item?.variantId).filter(Boolean))].sort().join(",")
            : null,
          shop: history.shop,
          mirrorBatchId: mirrorBatchId || null,
          title: isCreate ? productSet.title : existingProduct.title,
          image: isCreate ? null : existingProduct.featuredImageUrl,
          changeScope: "mixed",
          batchId,
          beforeValues: {
            ...(isCreate ? { csvCreate: true } : {}),
            productFieldChanges,
            variantFieldChanges,
          },
          afterValues: {
            productFieldChanges,
            variantFieldChanges,
          },
          productFieldChanges,
          variantFieldChanges,
          status: "pending",
          csvMutationRow: mutationRow,
        });
        explicitTargets.push({
          targetResourceType: "PRODUCT",
          targetIdentity: `PRODUCT:${effectiveProductId}`,
          productId: effectiveProductId,
          variantId: null,
          plannedMutation: {
            productFieldChanges,
            variantFieldChanges,
          },
          beforeValues: {
            ...(isCreate ? { csvCreate: true } : {}),
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
          statusNormalized: normalizeEditHistoryStatus("failed"),
          executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            BULK_EDIT_EXECUTION_STATES.FAILED,
          ),
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
        const authoritativeRecords = changeRecords.map((record) => {
            const {
              csvMutationRow,
              options,
              ...rest
            } = record;
            const productFields = Array.isArray(record.productFieldChanges)
              ? record.productFieldChanges.map((change) => change?.field).filter(Boolean)
              : [];
            const variantFields = Array.isArray(record.variantFieldChanges)
              ? record.variantFieldChanges.flatMap((group) =>
                  (Array.isArray(group?.changes) ? group.changes : [group])
                    .map((change) => change?.field)
                    .filter(Boolean)
                )
              : [];
            const fields = [...productFields, ...variantFields];
            const fieldPath = fields.length === 1
              ? `${variantFields.length ? "variant" : "product"}.${String(fields[0]).trim()}`
              : `atomic.import.${crypto
                  .createHash("sha256")
                  .update(JSON.stringify(fields.sort()))
                  .digest("hex")
                  .slice(0, 24)}`;
            return {
              ...rest,
              shop,
              editHistoryId: historyId,
              fieldPath,
              options: {
                csvMutationRow,
                csvImport: true,
                csvCreate: Boolean(record.beforeValues?.csvCreate),
                productOptions: options,
              },
            };
        });
        await db.$transaction((tx) =>
          upsertAuthoritativeChangeRecords({
            tx,
            records: authoritativeRecords,
          }),
        );
      }

      const normalizedFilterHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify(
            explicitTargets.map((target) => target.targetIdentity).sort(),
          ),
        )
        .digest("hex");

      const freezeStats = await freezeExplicitTargetSet({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        mirrorBatchId,
        normalizedFilterHash,
        targetGranularity: "PRODUCT",
        source: "CSV_IMPORT",
        targets: explicitTargets,
        returnStats: true,
      });
      const legacyFrozenCount = Number(freezeStats?.finalSnapshotCount || 0);

      const targetSetHash = await computeTargetSetHash({
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        shop: history.shop,
        mirrorBatchId,
      });

      const ownershipBeforeFinalize = await db.editHistory.count({
        where: {
          id: historyId,
          shop: history.shop,
          executionOwnerId: ownerId,
          executionLeaseUntil: { gt: new Date() },
          executionStateNormalized: { in: ["PLANNED", "TARGET_FREEZING"] },
        },
      });

      if (ownershipBeforeFinalize !== 1) {
        const error = new Error("IMPORT_OWNERSHIP_LOST");
        error.code = "IMPORT_OWNERSHIP_LOST";
        throw error;
      }

      const snapshotSet = await finalizeFrozenSnapshotSet({
        shop: history.shop,
        historyId,
        operationId: String(history.executionIdentity || "").trim() || `EDIT_HISTORY:${historyId}`,
        previewContractId: `CSV_IMPORT:${historyId}`,
        mirrorBatchId,
        targetDefinitionHash: normalizedFilterHash,
        compilerVersion: "csv-import-v1",
        projectionVersion: "csv-import-v1",
        source: "CSV_IMPORT",
      });
      const frozenCount = Number(snapshotSet?.targetCount || legacyFrozenCount);
      if (!snapshotSet?.id || frozenCount <= 0) {
        throw new Error("CSV_IMPORT_TARGET_SNAPSHOT_SET_EMPTY");
      }
      const frozenAt = new Date().toISOString();
      const executionPlan = buildCsvImportExecutionPlan({
        historyId,
        shop: history.shop,
        targetCount: frozenCount,
      });

      await db.editHistory.update({
        where: { id: historyId },
        data: {
          totalRows,
          totalItems: frozenCount,
          targetSnapshotCount: frozenCount,
          targetProductMirrorBatchId: mirrorBatchId,
          snapshotSetId: snapshotSet.id,
          undo: buildPlannedUndoState({
            allowed: !containsProductCreates,
            executionIdentity: history.executionIdentity || null,
          }),
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
            rawFilterInput: [],
            filterAst: null,
            normalizedFilterHash,
            freezeSource: "CSV_IMPORT",
            targetsFrozenAt: frozenAt,
            executionPlan,
            operationKey: executionPlan.operationKey,
            targetSnapshotRef: {
              snapshotSetId: snapshotSet.id,
              operationId: snapshotSet.operationId,
              status: snapshotSet.status,
              targetSetHash: snapshotSet.targetSetHash || null,
            },
          },
          targetingSnapshotMeta: {
            shop: history.shop,
            source: "CSV_IMPORT",
            mirrorBatchId,
            targetCount: frozenCount,
            normalizedFilterHash,
            targetSetHash: snapshotSet.targetSetHash || targetSetHash,
            targetGranularity: "PRODUCT",
            snapshotSetId: snapshotSet.id,
            resolvedAt: new Date(),
          },
        },
      });

      await db.spreadsheetFile.updateMany({
        where: { editHistoryId: historyId },
        data: { totalRows },
      });

      const ownershipBeforeEnqueue = await db.editHistory.count({
        where: {
          id: historyId,
          shop: history.shop,
          executionOwnerId: ownerId,
          executionLeaseUntil: { gt: new Date() },
          executionStateNormalized: {
            in: [
              normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.TARGET_FREEZING),
              normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.TARGET_FROZEN),
            ],
          },
        },
      });

      if (ownershipBeforeEnqueue !== 1) {
        const error = new Error("IMPORT_OWNERSHIP_LOST");
        error.code = "IMPORT_OWNERSHIP_LOST";
        throw error;
      }

      await addBulkEditExecuteJob({
        historyId,
        shop: history.shop,
        snapshotSetId: snapshotSet.id,
        source: "csv_import_pipeline",
        executionId: history.executionIdentity || historyId,
      });

      const queuedTransition = await db.editHistory.updateMany({
        where: {
          id: historyId,
          shop: history.shop,
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          snapshotSetId: snapshotSet.id,
        },
        data: {
          status: "processing",
          statusNormalized: normalizeEditHistoryStatus("processing"),
          executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.QUEUED,
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
            rawFilterInput: [],
            filterAst: null,
            normalizedFilterHash,
            freezeSource: "CSV_IMPORT",
            targetsFrozenAt: frozenAt,
            executionPlan,
            operationKey: executionPlan.operationKey,
            targetSnapshotRef: {
              snapshotSetId: snapshotSet.id,
              operationId: snapshotSet.operationId,
              status: snapshotSet.status,
              targetSetHash: snapshotSet.targetSetHash || null,
            },
          },
        },
      });
      if (queuedTransition.count !== 1) {
        const latest = await db.editHistory.findFirst({
          where: { id: historyId, shop: history.shop },
          select: { executionState: true, snapshotSetId: true },
        });
        if (
          latest?.snapshotSetId !== snapshotSet.id
          || latest?.executionState === OPERATION_LIFECYCLE_STATES.TARGET_FROZEN
        ) {
          throw new Error("CSV_IMPORT_MARK_QUEUED_CONFLICT");
        }
      }

      await clearKeyCaches(`${history.shop}:fetchHistories`);
      await removeLocalFile(filePath);

      return {
        success: true,
        historyId,
        totalRows,
        totalItems: frozenCount,
      };
    } catch (error) {
      const storageKey = job?.data?.storageKey;
      const terminal = isImportValidationError(error);
      const exhausted = isRetryExhausted(job);

      if (terminal || exhausted) {
        await removeLocalFile(filePath);
        if (storageKey) {
          await immutableObjectStorage.deleteObject(storageKey).catch(() => {});
        }

        await db.editHistory.updateMany({
          where: { id: historyId, ...(shop ? { shop } : {}) },
          data: {
            status: "failed",
            statusNormalized: normalizeEditHistoryStatus("failed"),
            executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
            executionStateNormalized: normalizeEditHistoryExecutionState(
              BULK_EDIT_EXECUTION_STATES.FAILED,
            ),
            error: appendExecutionError(
              null,
              buildExecutionError({
                code: "bulk_import_worker_failure",
                stage: "queue_execution",
                message: error.message,
                retryable: false,
                details: {
                  validation: error.details || null,
                  stack: error.stack || null,
                  failedAt: new Date().toISOString(),
                },
              }),
            ),
          },
        });
      } else {
        await markImportRetryWait(historyId, shop, error);
      }

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

bulkImportEditWorker.on("completed", (job, result) => {
  logger.info("Bulk import worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    executionId: job?.data?.executionId || null,
    totalRows: result?.totalRows ?? null,
    totalItems: result?.totalItems ?? null,
  });
});

bulkImportEditWorker.on("error", (error) => {
  logger.error("Bulk import worker error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: error?.message,
  });
});

bulkImportEditWorker.on("stalled", (jobId) => {
  logger.warn("Bulk import worker job stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
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
