import crypto from "crypto";
import { db } from "../repositories/repositoryDb.js";
import {
  ensureStoreForShop,
  logStoreMutation,
} from "../repositories/storeRepository.js";
import { recordMirrorAnomaly } from "./mirrorAnomalyService.js";
import { TargetingValidationError } from "./targeting/errors/TargetingValidationError.js";

export const MIRROR_STALE_REASONS = {
  FULL_SYNC_RUNNING: "FULL_SYNC_RUNNING",
  FULL_SYNC_FAILED: "FULL_SYNC_FAILED",
  PARTIAL_MIRROR_DETECTED: "PARTIAL_MIRROR_DETECTED",
  PRODUCT_WEBHOOK_MISSING_VARIANTS: "PRODUCT_WEBHOOK_MISSING_VARIANTS",
  WEBHOOK_OUT_OF_ORDER: "WEBHOOK_OUT_OF_ORDER",
  INVENTORY_RECONCILIATION_PENDING: "INVENTORY_RECONCILIATION_PENDING",
  COLLECTION_RECONCILIATION_PENDING: "COLLECTION_RECONCILIATION_PENDING",
  ORPHAN_VARIANTS_DETECTED: "ORPHAN_VARIANTS_DETECTED",
  PREVIEW_EXECUTION_MISMATCH: "PREVIEW_EXECUTION_MISMATCH",
};

function buildUnsafeUpdate(reason, summary = null) {
  return {
    mirrorHealthState: "UNSAFE",
    staleReason: reason,
    requiresMirrorRepair: true,
    mirrorUnsafeSince: new Date(),
    ...(summary ? { lastSyncErrorSummary: summary } : {}),
  };
}

export async function getStoreMirrorState(shop, tx = db) {
  return tx.store.findUnique({
    where: { shopUrl: shop },
    select: {
      shopUrl: true,
      currentProductMirrorBatchId: true,
      currentCollectionMirrorBatchId: true,
      mirrorHealthState: true,
      staleReason: true,
      requiresMirrorRepair: true,
      lastFullSyncAt: true,
      lastIncrementalSyncAt: true,
      lastWebhookProcessedAt: true,
      lastReconcileAt: true,
      lastInventoryReconcileAt: true,
      lastCollectionReconcileAt: true,
      mirrorUnsafeSince: true,
      lastSyncErrorSummary: true,
      syncProgressStage: true,
      isProductSyncing: true,
      isProductInitiallySyncing: true,
      hasCompletedShopifyBulkJob: true,
      isCollectionSyncing: true,
      storeTotalProducts: true,
    },
  });
}

export async function assertMirrorSafeForTargeting(shop, { purpose = "PREVIEW" } = {}) {
  const state = await getStoreMirrorState(shop);
  const normalizedPurpose = String(purpose || "PREVIEW").toUpperCase();
  const mirrorHealthState = String(state?.mirrorHealthState || "").toUpperCase();

  const isPreviewLike = normalizedPurpose === "PREVIEW" || normalizedPurpose === "EXPORT";
  const isUnsafeHealth = isPreviewLike
    ? ["UNSAFE", "REPAIR_REQUIRED"].includes(mirrorHealthState)
    : ["UNSAFE", "DEGRADED", "REPAIR_REQUIRED"].includes(mirrorHealthState);
  const missingActiveBatch = !state?.currentProductMirrorBatchId;
  const initialSyncIncomplete =
    !isPreviewLike &&
    (state?.isProductInitiallySyncing === true || state?.hasCompletedShopifyBulkJob === false);
  const lastSyncFailed = String(state?.staleReason || "").toUpperCase() === MIRROR_STALE_REASONS.FULL_SYNC_FAILED;
  const syncUnsafeNow =
    !isPreviewLike &&
    (state?.isProductSyncing === true || state?.isCollectionSyncing === true);

  if (
    !state ||
    missingActiveBatch ||
    initialSyncIncomplete ||
    lastSyncFailed ||
    isUnsafeHealth ||
    syncUnsafeNow
  ) {
    throw new TargetingValidationError(
      "Product data is still syncing. Please retry after sync completes.",
      {
        code: "TARGETING_REQUIRES_SYNC",
        meta: {
          purpose: normalizedPurpose,
          state: state || null,
        },
      },
    );
  }

  return state;
}

export async function markFullSyncStarted(shop, tx = db) {
  const store = await ensureStoreForShop({ shop }, tx);
  logStoreMutation("markFullSyncStarted.updateMany", {
    shop,
    storeId: store.id,
  });
  await tx.store.updateMany({
    where: { shopUrl: shop },
    data: {
      isProductSyncing: true,
      isProductInitiallySyncing: true,
      mirrorHealthState: "DEGRADED",
      syncProgressStage: "SHOPIFY_BULK_RUNNING",
      hasCompletedShopifyBulkJob: false,
      staleReason: MIRROR_STALE_REASONS.FULL_SYNC_RUNNING,
      productSyncStartedAt: new Date(),
      lastProductSyncAttemptAt: new Date(),
    },
  });
  return tx.store.findUnique({ where: { shopUrl: shop } });
}

export async function markMirrorStaging(shop, tx = db) {
  const store = await ensureStoreForShop({ shop }, tx);
  logStoreMutation("markMirrorStaging.updateMany", {
    shop,
    storeId: store.id,
  });
  await tx.store.updateMany({
    where: { shopUrl: shop },
    data: {
      syncProgressStage: "MIRROR_STAGING",
    },
  });
  return tx.store.findUnique({ where: { shopUrl: shop } });
}

export async function markFullSyncCompleted({
  shop,
  batchId,
  productCount,
  reconciliationAt = new Date(),
}, tx = db) {
  const store = await ensureStoreForShop({ shop }, tx);
  logStoreMutation("markFullSyncCompleted.updateMany", {
    shop,
    storeId: store.id,
    mirrorBatchId: batchId,
  });

  const promoteOperation = async (client) => {
    // 1. Promote MirrorBatch status to ACTIVE atomically
    await client.mirrorBatch.updateMany({
      where: {
        shop,
        id: batchId,
      },
      data: {
        status: "ACTIVE",
        activatedAt: reconciliationAt,
      },
    });

    // 2. Update store currentProductMirrorBatchId and sync status
    await client.store.updateMany({
      where: { shopUrl: shop },
      data: {
        currentProductMirrorBatchId: batchId,
        mirrorHealthState: "HEALTHY",
        staleReason: null,
        requiresMirrorRepair: false,
        mirrorUnsafeSince: null,
        lastSyncErrorSummary: null,
        lastFullSyncAt: reconciliationAt,
        lastReconcileAt: reconciliationAt,
        lastIncrementalSyncAt: reconciliationAt,
        lastWebhookProcessedAt: reconciliationAt,
        isProductSyncing: false,
        isProductInitiallySyncing: false,
        syncProgressStage: "IDLE",
        hasCompletedShopifyBulkJob: true,
        storeTotalProducts: productCount,
        productInitialSyncProgress: productCount,
        lastProductSyncAt: reconciliationAt,
        productSyncStartedAt: null,
        requiresProductSyncRecovery: false,
      },
    });

    return client.store.findUnique({ where: { shopUrl: shop } });
  };

  if (tx && typeof tx.$transaction !== "function") {
    return promoteOperation(tx);
  }

  return db.$transaction(promoteOperation);
}

export async function markFullSyncFailed({
  shop,
  reason = MIRROR_STALE_REASONS.FULL_SYNC_FAILED,
  errorSummary,
}) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("markFullSyncFailed.updateMany", {
    shop,
    storeId: store.id,
  });
  await db.store.updateMany({
    where: { shopUrl: shop },
    data: {
      ...buildUnsafeUpdate(reason, errorSummary),
      isProductSyncing: false,
      isProductInitiallySyncing: false,
      syncProgressStage: "IDLE",
    },
  });

  await recordMirrorAnomaly({
    shop,
    severity: "critical",
    type: "full_sync_failed",
    entityType: "store",
    entityId: shop,
    message: errorSummary || "Full product sync failed",
    details: { reason },
  });
}

export async function markWebhookProcessed(shop, details = {}, tx = db) {
  const store = await ensureStoreForShop({ shop }, tx);
  logStoreMutation("markWebhookProcessed.updateMany", {
    shop,
    storeId: store.id,
  });
  await tx.store.updateMany({
    where: { shopUrl: shop },
    data: {
      lastWebhookProcessedAt: new Date(),
      ...(details.lastIncrementalSyncAt ? { lastIncrementalSyncAt: details.lastIncrementalSyncAt } : {}),
    },
  });
  return tx.store.findUnique({ where: { shopUrl: shop } });
}

export async function markCollectionReconciliationPending(shop) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("markCollectionReconciliationPending.updateMany", {
    shop,
    storeId: store.id,
  });
  await db.store.updateMany({
    where: { shopUrl: shop },
    data: {
      mirrorHealthState: "DEGRADED",
      staleReason: MIRROR_STALE_REASONS.COLLECTION_RECONCILIATION_PENDING,
      lastCollectionReconcileAt: new Date(),
    },
  });
}

export async function markInventoryReconciliationPending(shop) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("markInventoryReconciliationPending.updateMany", {
    shop,
    storeId: store.id,
  });
  await db.store.updateMany({
    where: { shopUrl: shop },
    data: {
      mirrorHealthState: "DEGRADED",
      staleReason: MIRROR_STALE_REASONS.INVENTORY_RECONCILIATION_PENDING,
      lastInventoryReconcileAt: new Date(),
    },
  });
}

export async function markTargetedReconciliationPending({
  shop,
  reason = MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
  summary,
  details = null,
}) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("markTargetedReconciliationPending.updateMany", {
    shop,
    storeId: store.id,
  });
  await db.store.updateMany({
    where: { shopUrl: shop },
    data: {
      // The active batch remains readable after a verified targeted mutation.
      // DEGRADED blocks new executions while reconciliation is pending, but
      // unlike UNSAFE it does not hide the existing product table.
      mirrorHealthState: "DEGRADED",
      staleReason: reason,
      requiresMirrorRepair: false,
      mirrorUnsafeSince: null,
      ...(summary ? { lastSyncErrorSummary: summary } : {}),
    },
  });

  await recordMirrorAnomaly({
    shop,
    severity: "medium",
    type: "targeted_reconciliation_pending",
    entityType: "store",
    entityId: shop,
    message: summary || reason,
    details: {
      reason,
      ...(details || {}),
    },
  });
}

export async function markRepairRequired({
  shop,
  reason,
  summary,
  severity = "high",
  details = null,
}) {
  const store = await ensureStoreForShop({ shop });
  logStoreMutation("markRepairRequired.updateMany", {
    shop,
    storeId: store.id,
  });
  await db.store.updateMany({
    where: { shopUrl: shop },
    data: buildUnsafeUpdate(reason, summary),
  });

  await recordMirrorAnomaly({
    shop,
    severity,
    type: "repair_required",
    entityType: "store",
    entityId: shop,
    message: summary || reason,
    details: {
      reason,
      ...(details || {}),
    },
  });
}

export function createMirrorBatchId(prefix = "mirror") {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}`;
}

