import crypto from "crypto";
import { db } from "../repositories/repositoryDb.js";
import { recordMirrorAnomaly } from "./mirrorAnomalyService.js";
import { TargetingValidationError } from "./targeting/errors/TargetingValidationError.js";
import { addShopSyncJob } from "../Jobs/Queues/shopSyncJob.js";
import logger from "../utils/loggerUtils.js";

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
  NO_ACTIVE_BATCH: "NO_ACTIVE_BATCH",
  ACTIVE_BATCH_EMPTY: "ACTIVE_BATCH_EMPTY",
  DRIFT_DETECTED: "DRIFT_DETECTED",
  WEBHOOK_LAG: "WEBHOOK_LAG",
  FULL_SYNC_STALE: "FULL_SYNC_STALE",
  FULL_RESYNC_IN_PROGRESS: "FULL_RESYNC_IN_PROGRESS",
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

export async function assertMirrorSafeForBulkExecution(shop, { historyId = null } = {}) {
  const state = await getStoreMirrorState(shop);
  const health = String(state?.mirrorHealthState || "").toUpperCase();
  if (
    !state?.activeMirrorBatchId
    || state?.repairRequired
    || ["UNSAFE", "REPAIR_REQUIRED"].includes(health)
  ) {
    const error = new Error("MIRROR_UNSAFE_BULK_EDIT_BLOCKED");
    error.code = "MIRROR_UNSAFE_BULK_EDIT_BLOCKED";
    error.nonRetryable = true;
    throw error;
  }
  if (health === "DEGRADED") {
    logger.warn("BULK_EDIT_ON_DEGRADED_MIRROR", {
      shop,
      historyId,
      staleReason: state.staleReason || null,
    });
  }
  return state;
}

async function setMirrorHealth(shop, state, staleReason, repairRequired = false, details = null) {
  const current = await getStoreMirrorState(shop);
  if (
    String(current?.mirrorHealthState || "").toUpperCase() === state
    && (current?.staleReason || null) === (staleReason || null)
    && Boolean(current?.repairRequired) === Boolean(repairRequired)
  ) {
    return { state, staleReason, repairRequired, details, unchanged: true };
  }
  await db.store.update({
    where: { shopUrl: shop },
    data: {
      mirrorHealthState: state,
      staleReason,
      repairRequired,
      ...(state === "HEALTHY" ? { mirrorUnsafeSince: null } : {}),
    },
  });
  if (state !== "HEALTHY") {
    await recordMirrorAnomaly({
      shop,
      severity: state === "DEGRADED" ? "medium" : "critical",
      type: "mirror_health_transition",
      entityType: "store",
      entityId: shop,
      message: staleReason,
      details,
    });
  }
  return { state, staleReason, repairRequired, details };
}

export async function assessMirrorHealth(shop, { now = new Date() } = {}) {
  const store = await getStoreMirrorState(shop);
  if (!store) {
    return {
      state: "UNSAFE",
      staleReason: "STORE_NOT_INITIALIZED",
      repairRequired: true,
    };
  }
  if (!store.activeMirrorBatchId) {
    return setMirrorHealth(shop, "UNSAFE", MIRROR_STALE_REASONS.NO_ACTIVE_BATCH, true);
  }
  if (store.isProductSyncing || store.isProductInitialySyning) {
    return setMirrorHealth(
      shop,
      "DEGRADED",
      MIRROR_STALE_REASONS.FULL_SYNC_RUNNING,
      false,
    );
  }

  const [mirrorCount, staleSignals] = await Promise.all([
    db.product.count({
      where: { shop, mirrorBatchId: store.activeMirrorBatchId },
    }),
    db.mirrorReconcileSignal.count({
      where: {
        shop,
        status: "pending",
        latestEventAt: { lt: new Date(now.getTime() - 30 * 60 * 1000) },
      },
    }),
  ]);
  if (mirrorCount === 0) {
    return setMirrorHealth(shop, "REPAIR_REQUIRED", MIRROR_STALE_REASONS.ACTIVE_BATCH_EMPTY, true);
  }
  if (staleSignals > 0) {
    return setMirrorHealth(
      shop,
      "DEGRADED",
      MIRROR_STALE_REASONS.DRIFT_DETECTED,
      false,
      { driftedCount: staleSignals },
    );
  }

  const webhookLagMs = store.lastWebhookProcessedAt
    ? now.getTime() - new Date(store.lastWebhookProcessedAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (webhookLagMs > 60 * 60 * 1000) {
    return setMirrorHealth(
      shop,
      "DEGRADED",
      MIRROR_STALE_REASONS.WEBHOOK_LAG,
      false,
      { lagMs: webhookLagMs },
    );
  }

  const fullSyncAgeMs = store.lastFullSyncAt
    ? now.getTime() - new Date(store.lastFullSyncAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (fullSyncAgeMs > 24 * 60 * 60 * 1000) {
    return setMirrorHealth(
      shop,
      "DEGRADED",
      MIRROR_STALE_REASONS.FULL_SYNC_STALE,
      false,
      { ageMs: fullSyncAgeMs },
    );
  }

  return setMirrorHealth(shop, "HEALTHY", null, false);
}

export async function repairMirror(shop) {
  const [store, activeBulkEdit] = await Promise.all([
    getStoreMirrorState(shop),
    db.editHistory.findFirst({
      where: { shop, status: { in: ["processing", "pending"] } },
      select: { id: true },
    }),
  ]);
  if (activeBulkEdit) {
    return { deferred: true, reason: "BULK_EDIT_IN_PROGRESS" };
  }
  if (store?.isProductSyncing) {
    return { deferred: true, reason: "FULL_RESYNC_ALREADY_RUNNING" };
  }

  await db.store.update({
    where: { shopUrl: shop },
    data: {
      mirrorHealthState: "REPAIR_REQUIRED",
      repairRequired: true,
      staleReason: MIRROR_STALE_REASONS.FULL_RESYNC_IN_PROGRESS,
      mirrorUnsafeSince: new Date(),
    },
  });
  await addShopSyncJob({
    shop,
    syncType: "product",
    reason: "MIRROR_REPAIR",
  });
  return { queued: true };
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
