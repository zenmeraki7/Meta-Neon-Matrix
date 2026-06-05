import { getCache, setCache } from "../utils/cacheUtils.js";
import { db } from "../repositories/repositoryDb.js";
import {
  getStoreSyncDetailsByShop,
  getStoreSyncSummaryByShop,
  getStoreTrackedProductSyncByShop,
  recoverStaleProductSyncStateByShop,
} from "../repositories/storeRepository.js";
import {
  getLatestProductSyncByShop,
  getLatestProductSyncSummaryByShop,
} from "../repositories/syncRepository.js";

function toSyncStatusDetailDto(store, latestSync) {
  return {
    isCollectionSyncing: store.isCollectionSyncing,
    lastCollectionSyncAt: store.lastCollectionSyncAt,
    mirrorHealthState: store.mirrorHealthState,
    staleReason: store.staleReason,
    repairRequired: store.repairRequired,
    mirrorUnsafeSince: store.mirrorUnsafeSince,
    lastFullSyncAt: store.lastFullSyncAt,
    lastIncrementalSyncAt: store.lastIncrementalSyncAt,
    lastWebhookProcessedAt: store.lastWebhookProcessedAt,
    lastReconcileAt: store.lastReconcileAt,
    lastInventoryReconcileAt: store.lastInventoryReconcileAt,
    lastCollectionReconcileAt: store.lastCollectionReconcileAt,
    lastSyncErrorSummary: store.lastSyncErrorSummary,
    syncProgressStage: store.syncProgressStage,
    isProductTypeSyncing: store.isProductTypeSyncing,
    lastProductTypeSyncAt: store.lastProductTypeSyncAt,
    isProductInitialySyning: store.isProductInitialySyning,
    productInitialSyncProgress: store.productInitialSyncProgress,
    shopifyBulkJobCompleted: store.shopifyBulkJobCompleted,
    storeTotalProducts: store.storeTotalProducts,
    isProductSyncing: store.isProductSyncing,
    lastProductSyncAt: store.lastProductSyncAt,
    activeMirrorBatchId: store.activeMirrorBatchId,
    latestSync,
  };
}

function buildMissingStoreSyncStatus() {
  return {
    mirrorHealthState: "UNSAFE",
    staleReason: "STORE_NOT_INITIALIZED",
    repairRequired: true,
    mirrorUnsafeSince: null,
    lastFullSyncAt: null,
    lastIncrementalSyncAt: null,
    lastWebhookProcessedAt: null,
    lastReconcileAt: null,
    lastInventoryReconcileAt: null,
    lastCollectionReconcileAt: null,
    lastSyncErrorSummary: "Store setup is incomplete. Reopen the app from Shopify Admin or start product sync.",
    syncProgressStage: "IDLE",
    isCollectionSyncing: false,
    lastCollectionSyncAt: null,
    isProductTypeSyncing: false,
    lastProductTypeSyncAt: null,
    isProductInitialySyning: false,
    productInitialSyncProgress: 0,
    shopifyBulkJobCompleted: false,
    storeTotalProducts: 0,
    isProductSyncing: false,
    lastProductSyncAt: null,
    activeMirrorBatchId: null,
    latestSync: null,
  };
}

function buildMissingStoreSyncSummary() {
  const detail = buildMissingStoreSyncStatus();
  return {
    mirrorHealthState: detail.mirrorHealthState,
    staleReason: detail.staleReason,
    repairRequired: detail.repairRequired,
    mirrorUnsafeSince: detail.mirrorUnsafeSince,
    lastSyncErrorSummary: detail.lastSyncErrorSummary,
    lastFullSyncAt: detail.lastFullSyncAt,
    syncProgressStage: detail.syncProgressStage,
    isProductInitialySyning: detail.isProductInitialySyning,
    shopifyBulkJobCompleted: detail.shopifyBulkJobCompleted,
    storeTotalProducts: detail.storeTotalProducts,
    isProductSyncing: detail.isProductSyncing,
    lastProductSyncAt: detail.lastProductSyncAt,
    activeMirrorBatchId: detail.activeMirrorBatchId,
    activeProductRowCount: 0,
    hasActiveProductMirrorRows: false,
    canPreviewProducts: false,
    latestSync: null,
  };
}

function isSyncRunning(store) {
  return (
    store?.isProductSyncing === true ||
    store?.isProductInitialySyning === true ||
    store?.syncProgressStage === "SHOPIFY_BULK_RUNNING" ||
    store?.syncProgressStage === "MIRROR_STAGING"
  );
}

async function countActiveProductRows(shop, store) {
  if (!store?.activeMirrorBatchId) return 0;

  return db.product.count({
    where: {
      shop,
      mirrorBatchId: store.activeMirrorBatchId,
    },
  });
}

function canPreviewProductsFromSummary(store, activeProductRowCount) {
  if (!store?.activeMirrorBatchId) {
    return false;
  }

  if (activeProductRowCount > 0 && isSyncRunning(store)) {
    return true;
  }

  const state = String(store.mirrorHealthState || "").toUpperCase();
  const staleReason = String(store.staleReason || "").toUpperCase();
  const previewUnsafe =
    ["UNSAFE", "REPAIR_REQUIRED"].includes(state) || store.repairRequired === true;

  if (!previewUnsafe) {
    return true;
  }

  return state === "UNSAFE" && staleReason === "FULL_SYNC_FAILED" && activeProductRowCount > 0;
}

function toSyncStatusSummaryDto(store, latestSync, activeProductRowCount = 0) {
  const hasActiveProductMirrorRows =
    Boolean(store.activeMirrorBatchId) && activeProductRowCount > 0;
  const canPreviewProducts = canPreviewProductsFromSummary(store, activeProductRowCount);
  const latestSyncStatus = String(latestSync?.status || "").toLowerCase();
  const latestSyncRunning = ["processing", "running", "queued", "pending"].includes(latestSyncStatus);
  const syncInProgress = isSyncRunning(store) && latestSyncRunning;

  return {
    mirrorHealthState: store.mirrorHealthState,
    staleReason: store.staleReason,
    repairRequired: store.repairRequired,
    mirrorUnsafeSince: store.mirrorUnsafeSince,
    lastSyncErrorSummary: store.lastSyncErrorSummary,
    lastFullSyncAt: store.lastFullSyncAt,
    syncProgressStage: store.syncProgressStage,
    isProductInitialySyning: store.isProductInitialySyning,
    shopifyBulkJobCompleted: store.shopifyBulkJobCompleted,
    storeTotalProducts: store.storeTotalProducts,
    isProductSyncing: store.isProductSyncing,
    lastProductSyncAt: store.lastProductSyncAt,
    activeMirrorBatchId: store.activeMirrorBatchId,
    activeProductRowCount,
    productCount: activeProductRowCount,
    hasActiveProductMirrorRows,
    mirrorReady: hasActiveProductMirrorRows && canPreviewProducts,
    latestBatchId: store.activeMirrorBatchId,
    stage: syncInProgress ? store.syncProgressStage : "READY",
    syncInProgress,
    canPreviewProducts,
    latestSync: latestSync
      ? {
          id: latestSync.id,
          status: latestSync.status,
          stage: latestSync.stage,
          updatedAt: latestSync.updatedAt,
          errorMessage: latestSync.errorMessage,
          isInitialProductSync: latestSync.isInitialProductSync,
        }
      : null,
  };
}

export async function getSyncStatusDetailForShop(shop) {
  const recovery = await recoverStaleProductSyncStateByShop(shop);
  const cacheKey = `${shop}:sync_details`;
  const cached = recovery.recovered ? null : await getCache(cacheKey);
  if (cached) {
    return {
      success: true,
      shop,
      syncStatus: cached,
    };
  }

  const store = await getStoreSyncDetailsByShop(shop);

  if (!store) {
    return {
      success: true,
      shop,
      syncStatus: buildMissingStoreSyncStatus(),
    };
  }

  const latestSync = await getLatestProductSyncByShop(shop);

  const syncDetails = toSyncStatusDetailDto(store, latestSync);
  await setCache(cacheKey, syncDetails, 300);

  return {
    success: true,
    shop,
    syncStatus: syncDetails,
  };
}

export async function getSyncStatusSummaryForShop(shop) {
  const recovery = await recoverStaleProductSyncStateByShop(shop);
  const cacheKey = `${shop}:sync_summary:v2`;
  const cached = recovery.recovered ? null : await getCache(cacheKey);
  if (cached) {
    return {
      success: true,
      shop,
      syncStatus: cached,
    };
  }

  const [store, latestSync] = await Promise.all([
    getStoreSyncSummaryByShop(shop),
    getLatestProductSyncSummaryByShop(shop),
  ]);

  if (!store) {
    return {
      success: true,
      shop,
      syncStatus: buildMissingStoreSyncSummary(),
    };
  }

  const activeProductRowCount = await countActiveProductRows(shop, store);
  const syncSummary = toSyncStatusSummaryDto(store, latestSync, activeProductRowCount);
  await setCache(cacheKey, syncSummary, 60);

  return {
    success: true,
    shop,
    syncStatus: syncSummary,
  };
}

export async function getTrackedProductSyncStatus({
  shop,
  bulkOperationStatusReader = null,
}) {
  await recoverStaleProductSyncStateByShop(shop);
  const storeDetails = await getStoreTrackedProductSyncByShop(shop);

  if (!storeDetails) {
    return {
      success: true,
      message: "Store setup is incomplete. Reopen the app from Shopify Admin or start product sync.",
      status: "idle",
      stage: "IDLE",
      totalProducts: 0,
      processedProducts: 0,
      progress: 0,
    };
  }

  const latestSync = await getLatestProductSyncByShop(shop);

  const totalProducts = storeDetails.storeTotalProducts || 0;

  if (
    storeDetails.isProductSyncing === false &&
    storeDetails.isProductInitialySyning === false
  ) {
    return {
      success: true,
      message: "Product syncing completed.",
      status: "completed",
      stage: "IDLE",
      totalProducts,
      processedProducts: totalProducts,
      progress: 100,
    };
  }

  if (latestSync?.status === "failed") {
    return {
      success: false,
      message: latestSync.errorMessage || storeDetails.lastSyncErrorSummary || "Product sync failed",
      status: "failed",
      stage: latestSync.stage || "FAILED",
      totalProducts,
      processedProducts: storeDetails.productInitialSyncProgress || 0,
      progress:
        totalProducts > 0
          ? Math.min(
              Number((((storeDetails.productInitialSyncProgress || 0) / totalProducts) * 100).toFixed(2)),
              100,
            )
          : 0,
    };
  }

  if (!storeDetails.shopifyBulkJobCompleted) {
    if (!latestSync?.bulkOperationId) {
      return {
        success: true,
        message: "No product sync found",
        status: "idle",
        stage: "IDLE",
        totalProducts,
        processedProducts: 0,
        progress: 0,
      };
    }

    if (typeof bulkOperationStatusReader !== "function") {
      const error = new Error("Bulk operation status reader is required");
      error.code = "SYNC_STATUS_READER_REQUIRED";
      throw error;
    }

    const result = await bulkOperationStatusReader(latestSync.bulkOperationId);
    const shopifyBulkProgress = Number(result?.rootObjectCount || 0);

    return {
      success: true,
      message: "Product Sync in progress...",
      status: "syncing",
      stage: storeDetails.syncProgressStage || latestSync.stage || "SHOPIFY_BULK_RUNNING",
      totalProducts,
      processedProducts: shopifyBulkProgress,
      progress:
        totalProducts > 0
          ? Math.min(Number(((shopifyBulkProgress / totalProducts) * 100).toFixed(2)), 100)
          : 0,
    };
  }

  const processedProducts = storeDetails.productInitialSyncProgress || 0;
  return {
    success: true,
    message: "Product Sync in progress...",
    status: "syncing",
    stage: storeDetails.syncProgressStage || latestSync?.stage || "MIRROR_STAGING",
    totalProducts,
    processedProducts,
    progress:
      totalProducts > 0
        ? Math.min(Number(((processedProducts / totalProducts) * 100).toFixed(2)), 100)
        : 0,
  };
}
