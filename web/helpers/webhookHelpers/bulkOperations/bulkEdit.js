//web/helpers/webhookHelpers/bulkOperations/bulkEdit.js
import axios from "axios";
import {
  getSession,
  getShopOwnerEmailAddress,
} from "../../../utils/sessionHandler.js";
import { productEditConfirmationEmailHTML } from "../../../config/templates/productEditConfirmationTemplate.js";
import { sendEmail } from "../../../utils/emailHelper.js";
import { addbulkUndoJob } from "../../../Jobs/Queues/bulkUndoJob.js";
import { addbulkEditJob } from "../../../Jobs/Queues/bulkEditJob.js";
import { clearKeyCaches } from "../../../utils/cacheUtils.js";
import { prisma } from "../../../config/database.js";
import { finalizeRecurringRunFromHistory } from "../../../services/recurringEditExecutionService.js";
import { finalizeAutomaticProductRuleRunFromHistory } from "../../../services/automaticProductRuleExecutionService.js";
import { adminGraphqlWithRetry } from "../../../utils/shopifyAdminApi.js";
import {
  BULK_EDIT_EXECUTION_STATES,
  BULK_UNDO_STATES,
  appendExecutionError,
  buildExecutionError,
  isTerminalExecutionState,
  isTerminalUndoState,
  normalizeUndoState,
} from "../../../services/bulkEditExecutionStateService.js";

async function acquireBulkOperationFinalizeLock(lockKey) {
  const rows = await prisma.$queryRaw`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS locked
  `;

  return Boolean(rows?.[0]?.locked);
}

async function releaseBulkOperationFinalizeLock(lockKey) {
  await prisma.$queryRaw`
    SELECT pg_advisory_unlock(hashtext(${lockKey}))
  `;
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function preferIncomingFieldOrExisting(incoming, key, existing) {
  return hasOwn(incoming, key) && incoming[key] !== undefined
    ? incoming[key]
    : existing;
}

function preferIncomingStringFieldOrExisting(incoming, key, existing) {
  if (!hasOwn(incoming, key) || incoming[key] === undefined) {
    return existing;
  }

  const value = incoming[key];
  if (typeof value === "string" && value.trim() === "") {
    return existing;
  }

  return value;
}

function toNullableFloat(value) {
  if (value === undefined) return undefined;
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toNullableInt(value) {
  if (value === undefined) return undefined;
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function toNullableBoolean(value) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return null;
  return Boolean(value);
}

function calculateDurationMs(startedAt, completedAt = new Date()) {
  return Math.max(
    new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    0,
  );
}

function mergeProductForBulkMirror(existing, incoming) {
  return {
    shop: existing?.shop ?? incoming.shop,
    id: existing?.id ?? incoming.id,
    title: preferIncomingStringFieldOrExisting(incoming, "title", existing?.title ?? ""),
    handle: preferIncomingFieldOrExisting(incoming, "handle", existing?.handle ?? null),
    status: preferIncomingFieldOrExisting(incoming, "status", existing?.status ?? "ACTIVE"),
    productType: preferIncomingFieldOrExisting(incoming, "productType", existing?.productType ?? null),
    vendor: preferIncomingFieldOrExisting(incoming, "vendor", existing?.vendor ?? null),
    tags: Array.isArray(incoming.tags)
      ? incoming.tags
      : Array.isArray(existing?.tags)
        ? existing.tags
        : [],
    templateSuffix: preferIncomingFieldOrExisting(incoming, "templateSuffix", existing?.templateSuffix ?? null),
    descriptionHtml: preferIncomingFieldOrExisting(incoming, "descriptionHtml", existing?.descriptionHtml ?? null),
    descriptionText: preferIncomingFieldOrExisting(incoming, "descriptionText", existing?.descriptionText ?? null),

    createdAt: preferIncomingFieldOrExisting(incoming, "createdAt", existing?.createdAt ?? null),
    updatedAt: preferIncomingFieldOrExisting(incoming, "updatedAt", existing?.updatedAt ?? null),
    publishedAt: preferIncomingFieldOrExisting(incoming, "publishedAt", existing?.publishedAt ?? null),
    seoTitle: preferIncomingFieldOrExisting(incoming, "seoTitle", existing?.seoTitle ?? null),
    seoDescription: preferIncomingFieldOrExisting(incoming, "seoDescription", existing?.seoDescription ?? null),
    totalInventory: preferIncomingFieldOrExisting(incoming, "totalInventory", existing?.totalInventory ?? null),
    categoryId: preferIncomingFieldOrExisting(incoming, "categoryId", existing?.categoryId ?? null),
    categoryName: preferIncomingFieldOrExisting(incoming, "categoryName", existing?.categoryName ?? null),
    featuredImageUrl: preferIncomingFieldOrExisting(incoming, "featuredImageUrl", existing?.featuredImageUrl ?? null),
    featuredImageAltText: preferIncomingFieldOrExisting(incoming, "featuredImageAltText", existing?.featuredImageAltText ?? null),
    optionsJson: preferIncomingFieldOrExisting(incoming, "optionsJson", existing?.optionsJson ?? null),
    collectionsJson: preferIncomingFieldOrExisting(incoming, "collectionsJson", existing?.collectionsJson ?? null),
    option1Name: preferIncomingFieldOrExisting(incoming, "option1Name", existing?.option1Name ?? null),
    option2Name: preferIncomingFieldOrExisting(incoming, "option2Name", existing?.option2Name ?? null),
    option3Name: preferIncomingFieldOrExisting(incoming, "option3Name", existing?.option3Name ?? null),
    variantCount: preferIncomingFieldOrExisting(incoming, "variantCount", existing?.variantCount ?? null),
    visibleOnlineStore: preferIncomingFieldOrExisting(incoming, "visibleOnlineStore", existing?.visibleOnlineStore ?? null),
  };
}

function hasProductMirrorDetails(product) {
  if (!product || typeof product !== "object") return false;

  return [
    product.title,
    product.handle,
    product.productType,
    product.vendor,
    product.templateSuffix,
    product.descriptionHtml,
    product.descriptionText,
    product.createdAt,
    product.updatedAt,
    product.publishedAt,
    product.seoTitle,
    product.seoDescription,
    product.categoryId,
    product.categoryName,
    product.featuredImageUrl,
    product.featuredImageAltText,
    product.totalInventory,
    product.optionsJson,
    product.collectionsJson,
    product.option1Name,
    product.option2Name,
    product.option3Name,
    product.visibleOnlineStore,
  ].some((value) => {
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "string") return value.trim() !== "";
    return value !== undefined && value !== null;
  });
}

function toVariantNestedCreateInput(variant) {
  return {
    id: String(variant.id),
    title: variant.title ?? null,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    price: toNullableFloat(variant.price),
    compareAtPrice: toNullableFloat(variant.compareAtPrice),
    inventoryQuantity: toNullableInt(variant.inventoryQuantity),
    inventoryPolicy: variant.inventoryPolicy ?? null,
    taxable: toNullableBoolean(variant.taxable),
    taxCode: variant.taxCode ?? null,
    position: toNullableInt(variant.position),
    selectedOptionsJson: variant.selectedOptionsJson ?? null,
    cost: toNullableFloat(variant.cost),
    countryOfOrigin: variant.countryOfOrigin ?? null,
    hsTariffCode: variant.hsTariffCode ?? null,
    weight: toNullableFloat(variant.weight),
    weightUnit: variant.weightUnit ?? null,
    option1Value: variant.option1Value ?? null,
    option2Value: variant.option2Value ?? null,
    option3Value: variant.option3Value ?? null,
    physicalProduct: toNullableBoolean(variant.physicalProduct),
    profitMargin: toNullableFloat(variant.profitMargin),
    tracked: toNullableBoolean(variant.tracked),
  };
}

function toProductCreateInput(product, variants, mirrorBatchId = "legacy") {
  return {
    shop: String(product.shop),
    id: String(product.id),
    mirrorBatchId,
    title: product.title ?? "",
    handle: product.handle ?? null,
    status: product.status ?? "ACTIVE",
    productType: product.productType ?? null,
    vendor: product.vendor ?? null,
    tags: asArray(product.tags),
    templateSuffix: product.templateSuffix ?? null,
    descriptionHtml: product.descriptionHtml ?? null,
    descriptionText: product.descriptionText ?? null,
    createdAt: product.createdAt ?? null,
    updatedAt: product.updatedAt ?? null,
    publishedAt: product.publishedAt ?? null,
    seoTitle: product.seoTitle ?? null,
    seoDescription: product.seoDescription ?? null,
    totalInventory: toNullableInt(product.totalInventory),
    categoryId: product.categoryId ?? null,
    categoryName: product.categoryName ?? null,
    featuredImageUrl: product.featuredImageUrl ?? null,
    featuredImageAltText: product.featuredImageAltText ?? null,
    optionsJson: product.optionsJson ?? null,
    collectionsJson: product.collectionsJson ?? null,
    option1Name: product.option1Name ?? null,
    option2Name: product.option2Name ?? null,
    option3Name: product.option3Name ?? null,
    variantCount: toNullableInt(product.variantCount),
    visibleOnlineStore: toNullableBoolean(product.visibleOnlineStore),
    variants: {
      create: asArray(variants).map((variant) => toVariantNestedCreateInput(variant)),
    },
  };
}

function buildBulkFailureError(history, bulkOperation, stage, message, retryable = false) {
  return appendExecutionError(
    history.error,
    buildExecutionError({
      code: bulkOperation?.errorCode || "shopify_bulk_failure",
      stage,
      message,
      retryable,
      details: {
        bulkOperationId: bulkOperation?.id || history.bulkOperationId || null,
        bulkStatus: bulkOperation?.status || null,
        partialDataUrl: bulkOperation?.partialDataUrl || null,
        objectCount: bulkOperation?.objectCount || bulkOperation?.rootObjectCount || null,
      },
    }),
  );
}

async function claimBulkEditFinalization(history) {
  const undo = normalizeUndoState(history.undo);

  if (
    history.executionState === BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY &&
    history.status === "processing"
  ) {
    const updated = await prisma.editHistory.updateMany({
      where: {
        id: history.id,
        shop: history.shop,
        bulkOperationId: history.bulkOperationId,
        executionState: BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY,
        status: "processing",
      },
      data: {
        executionState: BULK_EDIT_EXECUTION_STATES.FINALIZING,
      },
    });

    return updated.count === 1 ? "edit" : null;
  }

  if (
    undo.status === "processing" &&
    undo.state === BULK_UNDO_STATES.AWAITING_SHOPIFY &&
    undo.bulkOperationId === history.bulkOperationId
  ) {
    const updated = await prisma.editHistory.updateMany({
      where: {
        id: history.id,
        shop: history.shop,
        bulkOperationId: history.bulkOperationId,
      },
      data: {
        undo: {
          ...undo,
          state: BULK_UNDO_STATES.FINALIZING,
        },
      },
    });

    return updated.count === 1 ? "undo" : null;
  }

  return null;
}

async function markHistoryFailure(history, bulkOperation, reason, stage, kind = "edit") {
  const undo = normalizeUndoState(history.undo);
  const completedAt = new Date();

  if (kind === "undo") {
    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        bulkOperationId: null,
        processingBatchId: null,
        undo: {
          ...undo,
          status: "failed",
          state:
            bulkOperation?.partialDataUrl ? BULK_UNDO_STATES.PARTIAL : BULK_UNDO_STATES.FAILED,
          completedAt,
          durationMs: calculateDurationMs(undo.startedAt || history.startedAt, completedAt),
          error: buildExecutionError({
            code: bulkOperation?.errorCode || "undo_bulk_failure",
            stage,
            message: reason,
            retryable: false,
            details: {
              bulkOperationId: bulkOperation?.id || history.bulkOperationId || null,
              bulkStatus: bulkOperation?.status || null,
              partialDataUrl: bulkOperation?.partialDataUrl || null,
            },
          }),
          bulkOperationId: null,
        },
      },
    });
    return;
  }

  await prisma.editHistory.update({
    where: { id: history.id },
    data: {
      status: bulkOperation?.partialDataUrl ? "partial" : "failed",
      executionState: bulkOperation?.partialDataUrl
        ? BULK_EDIT_EXECUTION_STATES.PARTIAL
        : BULK_EDIT_EXECUTION_STATES.FAILED,
      failureStage: stage,
      completedAt,
      durationMs: calculateDurationMs(history.startedAt, completedAt),
      processingBatchId: null,
      error: buildBulkFailureError(history, bulkOperation, stage, reason, false),
    },
  });
}

async function markProcessingBatchStatus(batchId, status) {
  if (!batchId) return;
  await prisma.changeRecord.updateMany({
    where: { batchId },
    data: { status },
  });
}

async function applyBulkMirrorUpdates(history, bulkOperation) {
  if (!bulkOperation?.url) {
    return;
  }

  const store = await prisma.store.findUnique({
    where: { shopUrl: history.shop },
    select: { activeMirrorBatchId: true },
  });

  const batchId =
    history.targetMirrorBatchId || store?.activeMirrorBatchId || "legacy";

  const records = await fetchBulkOperationData(bulkOperation.url, history.shop);
  if (!records.length) {
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      for (const { product, variants = [] } of records) {
        const existing = await tx.product.findFirst({
          where: {
            shop: product.shop,
            id: product.id,
            mirrorBatchId: batchId,
          },
          select: {
            shop: true,
            id: true,
            title: true,
            handle: true,
            status: true,
            productType: true,
            vendor: true,
            tags: true,
            templateSuffix: true,
            descriptionHtml: true,
            descriptionText: true,
            createdAt: true,
            updatedAt: true,
            publishedAt: true,
            seoTitle: true,
            seoDescription: true,
            totalInventory: true,
            categoryId: true,
            categoryName: true,
            featuredImageUrl: true,
            featuredImageAltText: true,
            optionsJson: true,
            collectionsJson: true,
            option1Name: true,
            option2Name: true,
            option3Name: true,
            variantCount: true,
            visibleOnlineStore: true,
          },
        });

        if (!existing && !hasProductMirrorDetails(product)) {
          const error = new Error(
            `Bulk mutation result only included product id ${product.id}, but no mirror product exists in batch ${batchId}`,
          );
          error.code = "bulk_mirror_product_missing_for_partial_result";
          throw error;
        }

        const mergedProduct = mergeProductForBulkMirror(existing, product);

        if (existing || hasProductMirrorDetails(product)) {
          await tx.product.upsert({
            where: {
              shop_id_mirrorBatchId: {
                shop: product.shop,
                id: product.id,
                mirrorBatchId: batchId,
              },
            },
            create: {
              shop: String(mergedProduct.shop),
              id: String(mergedProduct.id),
              mirrorBatchId: batchId,
              title: mergedProduct.title ?? "",
              handle: mergedProduct.handle ?? null,
              status: mergedProduct.status ?? "ACTIVE",
              productType: mergedProduct.productType ?? null,
              vendor: mergedProduct.vendor ?? null,
              tags: asArray(mergedProduct.tags),
              templateSuffix: mergedProduct.templateSuffix ?? null,
              descriptionHtml: mergedProduct.descriptionHtml ?? null,
              descriptionText: mergedProduct.descriptionText ?? null,
              createdAt: mergedProduct.createdAt ?? null,
              updatedAt: mergedProduct.updatedAt ?? null,
              publishedAt: mergedProduct.publishedAt ?? null,
              seoTitle: mergedProduct.seoTitle ?? null,
              seoDescription: mergedProduct.seoDescription ?? null,
              totalInventory: toNullableInt(mergedProduct.totalInventory),
              categoryId: mergedProduct.categoryId ?? null,
              categoryName: mergedProduct.categoryName ?? null,
              featuredImageUrl: mergedProduct.featuredImageUrl ?? null,
              featuredImageAltText: mergedProduct.featuredImageAltText ?? null,
              optionsJson: mergedProduct.optionsJson ?? null,
              collectionsJson: mergedProduct.collectionsJson ?? null,
              option1Name: mergedProduct.option1Name ?? null,
              option2Name: mergedProduct.option2Name ?? null,
              option3Name: mergedProduct.option3Name ?? null,
              variantCount: toNullableInt(mergedProduct.variantCount),
              visibleOnlineStore: toNullableBoolean(
                mergedProduct.visibleOnlineStore,
              ),
            },
            update: {
              title: mergedProduct.title ?? "",
              handle: mergedProduct.handle ?? null,
              status: mergedProduct.status ?? "ACTIVE",
              productType: mergedProduct.productType ?? null,
              vendor: mergedProduct.vendor ?? null,
              tags: asArray(mergedProduct.tags),
              templateSuffix: mergedProduct.templateSuffix ?? null,
              descriptionHtml: mergedProduct.descriptionHtml ?? null,
              descriptionText: mergedProduct.descriptionText ?? null,
              updatedAt: mergedProduct.updatedAt ?? null,
              publishedAt: mergedProduct.publishedAt ?? null,
              seoTitle: mergedProduct.seoTitle ?? null,
              seoDescription: mergedProduct.seoDescription ?? null,
              totalInventory: toNullableInt(mergedProduct.totalInventory),
              categoryId: mergedProduct.categoryId ?? null,
              categoryName: mergedProduct.categoryName ?? null,
              featuredImageUrl: mergedProduct.featuredImageUrl ?? null,
              featuredImageAltText:
                mergedProduct.featuredImageAltText ?? null,
              optionsJson: mergedProduct.optionsJson ?? null,
              collectionsJson: mergedProduct.collectionsJson ?? null,
              option1Name: mergedProduct.option1Name ?? null,
              option2Name: mergedProduct.option2Name ?? null,
              option3Name: mergedProduct.option3Name ?? null,
              variantCount: toNullableInt(mergedProduct.variantCount),
              visibleOnlineStore: toNullableBoolean(
                mergedProduct.visibleOnlineStore,
              ),
            },
          });
        }

        if (variants.length > 0) {
          for (const variant of variants) {
            const variantData = toVariantNestedCreateInput(variant);

            await tx.variant.upsert({
              where: {
                shop_id_mirrorBatchId: {
                  shop: product.shop,
                  id: variantData.id,
                  mirrorBatchId: batchId,
                },
              },
              create: {
                ...variantData,
                shop: product.shop,
                productId: product.id,
                mirrorBatchId: batchId,
              },
              update: {
                title: variantData.title,
                sku: variantData.sku,
                barcode: variantData.barcode,
                price: variantData.price,
                compareAtPrice: variantData.compareAtPrice,
                inventoryQuantity: variantData.inventoryQuantity,
                inventoryPolicy: variantData.inventoryPolicy,
                taxable: variantData.taxable,
                taxCode: variantData.taxCode,
                position: variantData.position,
                selectedOptionsJson: variantData.selectedOptionsJson,
                cost: variantData.cost,
                countryOfOrigin: variantData.countryOfOrigin,
                hsTariffCode: variantData.hsTariffCode,
                weight: variantData.weight,
                weightUnit: variantData.weightUnit,
                option1Value: variantData.option1Value,
                option2Value: variantData.option2Value,
                option3Value: variantData.option3Value,
                physicalProduct: variantData.physicalProduct,
                profitMargin: variantData.profitMargin,
                tracked: variantData.tracked,
              },
            });
          }
        }
      }
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  await clearKeyCaches(`${history.shop}:ProductFetch:`);
  await clearKeyCaches(`${history.shop}:ProductFilterValues:`);
  await clearKeyCaches(`${history.shop}:productTypes:`);
}

async function finalizeEditSuccess(history) {
  const session = await getSession(history.shop);
  const batch = asObject(history.batch);
  const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
  const nextProcessedCount = Math.min(
    Number(history.processedCount || 0) + batchTargetCount,
    Number(history.targetSnapshotCount || Number(history.totalItems || 0)),
  );
  const hasMore = Boolean(batch.hasMore);

  await markProcessingBatchStatus(history.processingBatchId, "completed");

  
  if (hasMore) {
    const updatedBatch = {
      ...batch,
      currentBatchId: null,
      currentBatchCount: 0,
      currentBatchTargetCount: 0,
      lastFinalizedAt: new Date().toISOString(),
    };

    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        processedCount: nextProcessedCount,
        durationMs: calculateDurationMs(history.startedAt),
        executionState: BULK_EDIT_EXECUTION_STATES.QUEUED,
        bulkOperationId: null,
        processingBatchId: null,
        batch: updatedBatch,
      },
    });

    await addbulkEditJob({
      historyId: history.id,
      shop: history.shop,
      source: "bulk_edit_continuation",
      executionId: history.executionIdentity || history.id,
    });

    return { continued: true };
  }

  const completedAt = new Date();
  const { email, shopOwner } = await getShopOwnerEmailAddress(session);

  await sendEmail(
    email,
    "Your product edits are complete",
    productEditConfirmationEmailHTML(shopOwner, history.shop, history),
    true,
  );

  await prisma.editHistory.update({
    where: { id: history.id },
    data: {
      status: "completed",
      executionState: BULK_EDIT_EXECUTION_STATES.COMPLETED,
      completedAt,
      editTime: completedAt,
      processedCount: nextProcessedCount,
      durationMs: calculateDurationMs(history.startedAt, completedAt),
      processingBatchId: null,
      bulkOperationId: null,
      batch: {
        ...batch,
        lastProductId: null,
        hasMore: false,
        currentBatchId: null,
        currentBatchCount: 0,
        currentBatchTargetCount: 0,
        lastFinalizedAt: completedAt.toISOString(),
      },
    },
  });

  await finalizeRecurringRunFromHistory({
    historyId: history.id,
    status: "SUCCESS",
  });

  await finalizeAutomaticProductRuleRunFromHistory({
    historyId: history.id,
    status: "SUCCESS",
  });

  return { continued: false };
}

async function finalizeUndoSuccess(history) {
  const undo = normalizeUndoState(history.undo);
  const batch = asObject(history.batch);
  const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
  const nextProcessedCount = Number(undo.processedCount || 0) + batchTargetCount;
  const hasMore = Boolean(batch.hasMore);

  await markProcessingBatchStatus(history.processingBatchId, "undo completed");

  if (hasMore) {
    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        bulkOperationId: null,
        processingBatchId: null,
        batch: {
          ...batch,
          currentBatchId: null,
          currentBatchCount: 0,
          currentBatchTargetCount: 0,
          lastUndoFinalizedAt: new Date().toISOString(),
        },
        undo: {
          ...undo,
          processedCount: nextProcessedCount,
          state: BULK_UNDO_STATES.QUEUED,
          bulkOperationId: null,
          durationMs: calculateDurationMs(undo.startedAt || history.startedAt),
        },
      },
    });

    await addbulkUndoJob({
      historyId: history.id,
      shop: history.shop,
      source: "bulk_undo_continuation",
      executionId: undo.executionIdentity || history.executionIdentity || history.id,
    });

    return { continued: true };
  }

  const completedAt = new Date();
  await prisma.editHistory.update({
    where: { id: history.id },
    data: {
      bulkOperationId: null,
      processingBatchId: null,
      batch: {
        ...batch,
        lastProductId: null,
        hasMore: false,
        currentBatchId: null,
        currentBatchCount: 0,
        currentBatchTargetCount: 0,
        lastUndoFinalizedAt: completedAt.toISOString(),
      },
      undo: {
        ...undo,
        status: "completed",
        state: BULK_UNDO_STATES.COMPLETED,
        allowed: false,
        completedAt,
        processedCount: nextProcessedCount,
        durationMs: calculateDurationMs(undo.startedAt || history.startedAt, completedAt),
        bulkOperationId: null,
      },
    },
  });

  await clearKeyCaches(`${history.shop}:historyChanges:${history.id}`);
  return { continued: false };
}

export async function handleProductEditOperation({ bulkOperationId, shop = null }) {
  const finalizeLockKey = `bulk-operation-finalize:${bulkOperationId}`;
  const locked = await acquireBulkOperationFinalizeLock(finalizeLockKey);
  if (!locked) {
    return { success: true, skipped: true, reason: "finalizer_locked" };
  }

  try {
    const history = await prisma.editHistory.findFirst({
      where: {
        bulkOperationId,
        ...(shop ? { shop } : {}),
      },
    });

    if (!history) {
      return { success: false, reason: "history_not_found" };
    }

    const claimKind = await claimBulkEditFinalization(history);
    if (!claimKind) {
      const undo = normalizeUndoState(history.undo);
      if (
        isTerminalExecutionState(history.executionState) &&
        (!undo.state || isTerminalUndoState(undo.state))
      ) {
        return { success: true, skipped: true, reason: "already_finalized" };
      }

      return { success: true, skipped: true, reason: "not_claimable" };
    }

    const session = await getSession(history.shop);
    const bulkOperation = await fetchBulkOperationDetails(session, bulkOperationId);
    if (["CREATED", "RUNNING"].includes(bulkOperation?.status)) {
  await prisma.editHistory.updateMany({
    where: {
      id: history.id,
      shop: history.shop,
      executionState: BULK_EDIT_EXECUTION_STATES.FINALIZING,
      bulkOperationId,
    },
    data: {
      executionState: BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY,
    },
  });

  const error = new Error(`Shopify bulk operation still ${bulkOperation.status}`);
  error.code = "shopify_bulk_operation_not_ready";
  error.retryable = true;
  throw error;
}
    const hasFailure =
      bulkOperation?.errorCode ||
      ["FAILED", "CANCELED", "CANCELING"].includes(bulkOperation?.status);

    if (hasFailure || bulkOperation?.partialDataUrl) {
      await markProcessingBatchStatus(
        history.processingBatchId,
        bulkOperation?.partialDataUrl ? "partial" : "failed",
      );

      await markHistoryFailure(
        history,
        bulkOperation,
        bulkOperation?.partialDataUrl
          ? "Shopify bulk operation completed with partial failures"
          : "Shopify bulk operation failed",
        claimKind === "undo" ? "undo_bulk_mutation" : "shopify_bulk_mutation",
        claimKind,
      );

      if (claimKind === "edit") {
        await finalizeRecurringRunFromHistory({
          historyId: history.id,
          status: "FAILED",
          errorMessage: "Shopify bulk operation failed",
        });

        await finalizeAutomaticProductRuleRunFromHistory({
          historyId: history.id,
          status: "FAILED",
          errorMessage: "Shopify bulk operation failed",
        });
      }

      await clearKeyCaches(`${history.shop}:historyDetails:${history.id}`);
      return { success: false, reason: "bulk_operation_failed" };
    }
if (!bulkOperation?.url) {
  await markProcessingBatchStatus(history.processingBatchId, "failed");

  await markHistoryFailure(
    history,
    bulkOperation,
    "Shopify bulk operation completed without a result URL",
    "shopify_bulk_mutation_missing_result_url",
    claimKind,
  );

  await clearKeyCaches(`${history.shop}:historyDetails:${history.id}`);
  await clearKeyCaches(`${history.shop}:historyChanges:${history.id}`);

  return {
    success: false,
    reason: "shopify_bulk_mutation_missing_result_url",
  };
}
  try {
  await applyBulkMirrorUpdates(history, bulkOperation);
} catch (error) {
  await markProcessingBatchStatus(history.processingBatchId, "failed");

  await markHistoryFailure(
    history,
    bulkOperation,
    error.message,
    error.code || "shopify_bulk_mutation_result_parse",
    claimKind,
  );

  if (claimKind === "edit") {
    await finalizeRecurringRunFromHistory({
      historyId: history.id,
      status: "FAILED",
      errorMessage: error.message,
    });

    await finalizeAutomaticProductRuleRunFromHistory({
      historyId: history.id,
      status: "FAILED",
      errorMessage: error.message,
    });
  }

  await clearKeyCaches(`${history.shop}:historyDetails:${history.id}`);
  await clearKeyCaches(`${history.shop}:historyChanges:${history.id}`);

  return {
    success: false,
    reason: error.code || "shopify_bulk_mutation_result_parse",
    message: error.message,
  };
}

if (claimKind === "edit") {
  const result = await finalizeEditSuccess(history);
  await clearKeyCaches(`${history.shop}:historyDetails:${history.id}`);
  await clearKeyCaches(`${history.shop}:historyChanges:${history.id}`);

  return { success: true, continued: result.continued, kind: "edit" };
}

const result = await finalizeUndoSuccess(history);
await clearKeyCaches(`${history.shop}:historyDetails:${history.id}`);
await clearKeyCaches(`${history.shop}:historyChanges:${history.id}`);

return { success: true, continued: result.continued, kind: "undo" };
  } finally {
    await releaseBulkOperationFinalizeLock(finalizeLockKey).catch(() => { });
  }
}

function extractProductSetUserErrors(parsed) {
  const productSet = parsed?.data?.productSet;

  const directErrors = Array.isArray(productSet?.userErrors)
    ? productSet.userErrors
    : [];

  const operationErrors = Array.isArray(
    productSet?.productSetOperation?.userErrors
  )
    ? productSet.productSetOperation.userErrors
    : [];

  return [...directErrors, ...operationErrors].filter(Boolean);
}

function isCompletedProductSetOperation(parsed) {
  const status = parsed?.data?.productSet?.productSetOperation?.status;
  if (!status) return true;
  return ["COMPLETE", "COMPLETED"].includes(status);
}

export async function fetchBulkOperationData(url, shop) {
  const response = await axios.get(url, {
    responseType: "text",
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const operations = [];
  const rowErrors = [];
  const malformedRows = [];

  const lines = response.data.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      const userErrors = extractProductSetUserErrors(parsed);
      if (userErrors.length > 0) {
        rowErrors.push({
          userErrors,
          row: parsed,
        });
        continue;
      }

      if (!isCompletedProductSetOperation(parsed)) {
        rowErrors.push({
          userErrors: [
            {
              field: ["productSetOperation", "status"],
              message: `Product set operation did not complete: ${parsed?.data?.productSet?.productSetOperation?.status}`,
            },
          ],
          row: parsed,
        });
        continue;
      }

      const product = parsed?.data?.productSet?.product;

      if (!product?.id) {
        malformedRows.push(parsed);
        continue;
      }

      const variants = asArray(product?.variants?.edges)
        .map((edge) => edge?.node)
        .filter((node) => node?.id)
        .map((node) => ({
          id: node.id,
          title: node.title ?? null,
          sku: node.sku ?? null,
          barcode: node.barcode ?? null,
          price: node.price != null ? Number(node.price) : null,
          compareAtPrice:
            node.compareAtPrice != null ? Number(node.compareAtPrice) : null,
          inventoryQuantity:
            node.inventoryQuantity != null ? Number(node.inventoryQuantity) : null,
          inventoryPolicy: node.inventoryPolicy ?? null,
          taxable: node.taxable ?? null,
          taxCode: node.taxCode ?? null,
          position: node.position != null ? Number(node.position) : null,
          selectedOptionsJson: node.selectedOptions ?? null,
          cost:
            node.inventoryItem
              ? node.inventoryItem.unitCost?.amount != null
                ? Number(node.inventoryItem.unitCost.amount)
                : null
              : undefined,
          countryOfOrigin: node.inventoryItem
            ? node.inventoryItem.countryCodeOfOrigin ?? null
            : undefined,
          hsTariffCode: node.inventoryItem
            ? node.inventoryItem.harmonizedSystemCode ?? null
            : undefined,
          weight:
            node.inventoryItem
              ? node.inventoryItem.measurement?.weight?.value != null
                ? Number(node.inventoryItem.measurement.weight.value)
                : null
              : undefined,
          weightUnit: node.inventoryItem
            ? node.inventoryItem.measurement?.weight?.unit ?? null
            : undefined,
          option1Value: node.selectedOptions?.[0]?.value ?? null,
          option2Value: node.selectedOptions?.[1]?.value ?? null,
          option3Value: node.selectedOptions?.[2]?.value ?? null,
          physicalProduct: node.inventoryItem
            ? node.inventoryItem.requiresShipping ?? null
            : undefined,
          tracked: node.inventoryItem
            ? node.inventoryItem.tracked ?? null
            : undefined,
          profitMargin: undefined,
        }));

      operations.push({
        product: {
          shop,
          id: product.id,
          title: hasOwn(product, "title") ? product.title ?? null : undefined,
          handle: hasOwn(product, "handle") ? product.handle ?? null : undefined,
          status: hasOwn(product, "status") ? product.status ?? null : undefined,
          productType: hasOwn(product, "productType")
            ? product.productType ?? null
            : undefined,
          vendor: hasOwn(product, "vendor") ? product.vendor ?? null : undefined,
          templateSuffix: hasOwn(product, "templateSuffix")
            ? product.templateSuffix ?? null
            : undefined,
          descriptionHtml: hasOwn(product, "descriptionHtml")
            ? product.descriptionHtml ?? null
            : undefined,
          descriptionText: hasOwn(product, "descriptionHtml") && product.descriptionHtml
            ? product.descriptionHtml
                .replace(/<[^>]*>/g, " ")
                .replace(/\s{2,}/g, " ")
                .trim() || null
            : hasOwn(product, "descriptionHtml")
              ? null
              : undefined,
          createdAt: hasOwn(product, "createdAt")
            ? product.createdAt ? new Date(product.createdAt) : null
            : undefined,
          updatedAt: hasOwn(product, "updatedAt")
            ? product.updatedAt ? new Date(product.updatedAt) : null
            : undefined,
          publishedAt: hasOwn(product, "publishedAt")
            ? product.publishedAt ? new Date(product.publishedAt) : null
            : undefined,
          tags: Array.isArray(product.tags) ? product.tags : undefined,
          categoryId: hasOwn(product, "category")
            ? product.category?.id ?? null
            : undefined,
          categoryName: hasOwn(product, "category")
            ? product.category?.name ?? null
            : undefined,
          seoTitle: hasOwn(product, "seo")
            ? product.seo?.title ?? null
            : undefined,
          seoDescription: hasOwn(product, "seo")
            ? product.seo?.description ?? null
            : undefined,
          totalInventory:
            hasOwn(product, "totalInventory")
              ? product.totalInventory != null ? Number(product.totalInventory) : null
              : undefined,
          featuredImageUrl: hasOwn(product, "featuredImage")
            ? product.featuredImage?.url ?? null
            : undefined,
          featuredImageAltText: hasOwn(product, "featuredImage")
            ? product.featuredImage?.altText ?? null
            : undefined,
          optionsJson: hasOwn(product, "options") ? product.options ?? null : undefined,
          collectionsJson: product?.collections
            ? asArray(product.collections.edges).map(({ node }) => ({
                id: node?.id ?? null,
                title: node?.title ?? null,
              }))
            : undefined,
          option1Name: hasOwn(product, "options")
            ? product.options?.[0]?.name ?? null
            : undefined,
          option2Name: hasOwn(product, "options")
            ? product.options?.[1]?.name ?? null
            : undefined,
          option3Name: hasOwn(product, "options")
            ? product.options?.[2]?.name ?? null
            : undefined,
          variantCount: hasOwn(product, "variants") ? variants.length : undefined,
          visibleOnlineStore: undefined,
        },
        variants,
      });
    } catch (error) {
      malformedRows.push({
        line,
        message: error.message,
      });
    }
  }

  if (rowErrors.length > 0) {
    const error = new Error(
      `Shopify bulk mutation row errors: ${JSON.stringify(
        rowErrors.slice(0, 5),
      )}`,
    );
    error.code = "shopify_bulk_mutation_user_errors";
    error.rowErrors = rowErrors;
    throw error;
  }

  if (operations.length === 0) {
    const error = new Error(
      `Shopify bulk mutation returned no successful product rows. Malformed rows: ${JSON.stringify(
        malformedRows.slice(0, 5),
      )}`,
    );
    error.code = "shopify_bulk_mutation_no_success_rows";
    error.malformedRows = malformedRows;
    throw error;
  }

  return operations;
}

async function processNextEdit(shop) {
  const nextEdit = await prisma.editHistory.findFirst({
    where: {
      shop,
      status: { in: ["pending", "Undo pending"] },
    },
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      shop: true,
      status: true,
      executionIdentity: true,
      undo: true,
    },
  });

  if (!nextEdit) return;

  if (nextEdit.status === "Undo pending") {
    const undo = normalizeUndoState(nextEdit.undo);
    await addbulkUndoJob({
      historyId: nextEdit.id,
      shop: nextEdit.shop,
      source: "bulk_edit_followup_undo",
      executionId: undo.executionIdentity || nextEdit.executionIdentity || nextEdit.id,
    });
    return;
  }

  await addbulkEditJob({
    historyId: nextEdit.id,
    shop: nextEdit.shop,
    source: "bulk_edit_followup",
    executionId: nextEdit.executionIdentity || nextEdit.id,
  });
}

async function fetchBulkOperationDetails(session, bulkOperationId) {
  const query = `query GetBulkOperationResults($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        url
        partialDataUrl
        objectCount
        rootObjectCount
        completedAt
        createdAt
        fileSize
        type
      }
    }
  }`;

  const response = await adminGraphqlWithRetry({
    session,
    shop: session?.shop,
    operationName: "bulkOperationMutationStatus",
    data: {
      query,
      variables: { id: bulkOperationId },
    },
  });

  return response.body?.data?.node ?? null;
}

export { processNextEdit };
