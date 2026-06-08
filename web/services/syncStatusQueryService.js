import { getBulkEditStatus } from "../utils/bulkOperationHelper.js";
import { getCache, setCache } from "../utils/cacheUtils.js";
import {
  getStoreSyncDetailsByShop,
  getStoreSyncSummaryByShop,
  getStoreTrackedProductSyncByShop,
  recoverStaleProductSyncStateByShop,
} from "../repositories/storeRepository.js";
import {
  getActiveProductCountByShop,
  getLatestProductSyncByShop,
  getLatestCompletedProductSyncByShop,
  getLatestProductSyncSummaryByShop,
} from "../repositories/syncRepository.js";

function buildProductSyncTruth({ store, latestSync, latestCompletedSync, productCount }) {
  const safeProductCount = Number(productCount || 0);
  const productsSynced =
    latestCompletedSync?.status === "completed" &&
    safeProductCount > 0;

  return {
    productCount: safeProductCount,
    productsSynced,
    syncNeeded: !latestCompletedSync || safeProductCount === 0,
    mirrorReady: Boolean(store),
    emptyMirror: safeProductCount === 0,
    latestCompletedSync: latestCompletedSync
      ? {
          id: latestCompletedSync.id,
          status: latestCompletedSync.status,
          updatedAt: latestCompletedSync.updatedAt,
          recordCount: latestCompletedSync.recordCount,
          syncBatchId: latestCompletedSync.syncBatchId,
        }
      : null,
    latestSyncStatus: latestSync?.status || null,
  };
}

function toSyncStatusDetailDto(store, latestSync, latestCompletedSync, productCount) {
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
    ...buildProductSyncTruth({ store, latestSync, latestCompletedSync, productCount }),
  };
}

function toSyncStatusSummaryDto(store, latestSync, latestCompletedSync, productCount) {
  return {
    syncProgressStage: store.syncProgressStage,
    isProductInitialySyning: store.isProductInitialySyning,
    shopifyBulkJobCompleted: store.shopifyBulkJobCompleted,
    storeTotalProducts: store.storeTotalProducts,
    isProductSyncing: store.isProductSyncing,
    lastProductSyncAt: store.lastProductSyncAt,
    activeMirrorBatchId: store.activeMirrorBatchId,
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
    ...buildProductSyncTruth({ store, latestSync, latestCompletedSync, productCount }),
  };
}

export async function getSyncStatusDetailForShop(shop) {
  const recovery = await recoverStaleProductSyncStateByShop(shop);
  const cacheKey = `${shop}:sync_details:v2`;
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
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
  }

  const [latestSync, latestCompletedSync] = await Promise.all([
    getLatestProductSyncByShop(shop),
    getLatestCompletedProductSyncByShop(shop),
  ]);
  const productCount = await getActiveProductCountByShop(shop, store.activeMirrorBatchId);

  const syncDetails = toSyncStatusDetailDto(store, latestSync, latestCompletedSync, productCount);
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

  const [store, latestSync, latestCompletedSync] = await Promise.all([
    getStoreSyncSummaryByShop(shop),
    getLatestProductSyncSummaryByShop(shop),
    getLatestCompletedProductSyncByShop(shop),
  ]);

  if (!store) {
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
  }

  const productCount = await getActiveProductCountByShop(shop, store.activeMirrorBatchId);
  const syncSummary = toSyncStatusSummaryDto(store, latestSync, latestCompletedSync, productCount);
  await setCache(cacheKey, syncSummary, 60);

  return {
    success: true,
    shop,
    syncStatus: syncSummary,
  };
}

export async function getTrackedProductSyncStatus({ session, shop }) {
  await recoverStaleProductSyncStateByShop(shop);
  const storeDetails = await getStoreTrackedProductSyncByShop(shop);

  if (!storeDetails) {
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
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

    const result = await getBulkEditStatus(latestSync.bulkOperationId, session);
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
