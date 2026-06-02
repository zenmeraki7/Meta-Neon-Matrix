import crypto from "crypto";
import { db } from "../repositories/repositoryDb.js";
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
    repairRequired: true,
    mirrorUnsafeSince: new Date(),
    ...(summary ? { lastSyncErrorSummary: summary } : {}),
  };
}

export async function getStoreMirrorState(shop, tx = db) {
  return tx.store.findUnique({
    where: { shopUrl: shop },
    select: {
      shopUrl: true,
      activeMirrorBatchId: true,
      activeCollectionBatchId: true,
      mirrorHealthState: true,
      staleReason: true,
      repairRequired: true,
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
      isProductInitialySyning: true,
      shopifyBulkJobCompleted: true,
      isCollectionSyncing: true,
      storeTotalProducts: true,
    },
  });
}

export async function assertMirrorSafeForTargeting(shop, { purpose = "PREVIEW" } = {}) {
  const state = await getStoreMirrorState(shop);

  const isUnsafeHealth = ["UNSAFE", "DEGRADED"].includes(
    String(state?.mirrorHealthState || "").toUpperCase(),
  );
  const missingActiveBatch = !state?.activeMirrorBatchId;
  const initialSyncIncomplete =
    state?.isProductInitialySyning === true || state?.shopifyBulkJobCompleted === false;
  const lastSyncFailed = String(state?.staleReason || "").toUpperCase() === MIRROR_STALE_REASONS.FULL_SYNC_FAILED;
  const syncUnsafeNow = state?.isProductSyncing === true || state?.isCollectionSyncing === true;

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
        code: "TARGETING_MIRROR_UNSAFE",
        meta: {
          purpose,
          state: state || null,
        },
      },
    );
  }

  return state;
}

export async function markFullSyncStarted(shop, tx = db) {
  return tx.store.update({
    where: { shopUrl: shop },
    data: {
      isProductSyncing: true,
      isProductInitialySyning: true,
      mirrorHealthState: "DEGRADED",
      syncProgressStage: "SHOPIFY_BULK_RUNNING",
      shopifyBulkJobCompleted: false,
      staleReason: MIRROR_STALE_REASONS.FULL_SYNC_RUNNING,
      lastProductSyncAt: new Date(),
    },
  });
}

export async function markMirrorStaging(shop, tx = db) {
  return tx.store.update({
    where: { shopUrl: shop },
    data: {
      syncProgressStage: "MIRROR_STAGING",
    },
  });
}

export async function markFullSyncCompleted({
  shop,
  batchId,
  productCount,
  reconciliationAt = new Date(),
}, tx = db) {
  return tx.store.update({
    where: { shopUrl: shop },
    data: {
      activeMirrorBatchId: batchId,
      mirrorHealthState: "HEALTHY",
      staleReason: null,
      repairRequired: false,
      mirrorUnsafeSince: null,
      lastSyncErrorSummary: null,
      lastFullSyncAt: reconciliationAt,
      lastReconcileAt: reconciliationAt,
      lastIncrementalSyncAt: reconciliationAt,
      lastWebhookProcessedAt: reconciliationAt,
      isProductSyncing: false,
      isProductInitialySyning: false,
      syncProgressStage: "IDLE",
      shopifyBulkJobCompleted: true,
      storeTotalProducts: productCount,
      productInitialSyncProgress: productCount,
    },
  });
}

export async function markFullSyncFailed({
  shop,
  reason = MIRROR_STALE_REASONS.FULL_SYNC_FAILED,
  errorSummary,
}) {
  await db.store.update({
    where: { shopUrl: shop },
    data: {
      ...buildUnsafeUpdate(reason, errorSummary),
      isProductSyncing: false,
      isProductInitialySyning: false,
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
  return tx.store.update({
    where: { shopUrl: shop },
    data: {
      lastWebhookProcessedAt: new Date(),
      ...(details.lastIncrementalSyncAt ? { lastIncrementalSyncAt: details.lastIncrementalSyncAt } : {}),
    },
  });
}

export async function markCollectionReconciliationPending(shop) {
  await db.store.update({
    where: { shopUrl: shop },
    data: {
      mirrorHealthState: "DEGRADED",
      staleReason: MIRROR_STALE_REASONS.COLLECTION_RECONCILIATION_PENDING,
      lastCollectionReconcileAt: new Date(),
    },
  });
}

export async function markInventoryReconciliationPending(shop) {
  await db.store.update({
    where: { shopUrl: shop },
    data: {
      mirrorHealthState: "DEGRADED",
      staleReason: MIRROR_STALE_REASONS.INVENTORY_RECONCILIATION_PENDING,
      lastInventoryReconcileAt: new Date(),
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
  await db.store.update({
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

