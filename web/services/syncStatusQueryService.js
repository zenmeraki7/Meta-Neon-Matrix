import { getBulkEditStatus } from "../utils/bulkOperationHelper.js";
import { getCache, setCache } from "../utils/cacheUtils.js";
import {
  getStoreSyncDetailsByShop,
  getStoreSyncSummaryByShop,
  getStoreTrackedProductSyncByShop,
  ensureStoreForShop,
  recoverStaleProductSyncStateByShop,
} from "../repositories/storeRepository.js";
import {
  getActiveProductCountByShop,
  getLatestProductSyncByShop,
  getLatestCompletedProductSyncByShop,
  getLatestProductSyncSummaryByShop,
} from "../repositories/syncRepository.js";

const DEFAULT_STORE_SYNC_STATE = Object.freeze({
  isCollectionSyncing: false,
  lastCollectionSyncAt: null,
  mirrorHealthState: "UNSAFE",
  staleReason: null,
  repairRequired: true,
  mirrorUnsafeSince: null,
  lastFullSyncAt: null,
  lastIncrementalSyncAt: null,
  lastWebhookProcessedAt: null,
  lastReconcileAt: null,
  lastInventoryReconcileAt: null,
  lastCollectionReconcileAt: null,
  lastSyncErrorSummary: null,
  syncProgressStage: "IDLE",
  isProductTypeSyncing: false,
  lastProductTypeSyncAt: null,
  isProductInitialySyning: false,
  productInitialSyncProgress: 0,
  shopifyBulkJobCompleted: false,
  storeTotalProducts: 0,
  isProductSyncing: false,
  lastProductSyncAt: null,
  productSyncStartedAt: null,
  activeMirrorBatchId: null,
});

function normalizeStoreSyncState(store) {
  return store || DEFAULT_STORE_SYNC_STATE;
}

function isActiveStoreSyncState(store) {
  if (!store) return false;
  return (
    store.isProductSyncing === true ||
    store.isProductInitialySyning === true ||
    store.syncProgressStage === "SHOPIFY_BULK_RUNNING" ||
    store.syncProgressStage === "MIRROR_STAGING"
  );
}

async function resolveActiveProductCount(shop, store) {
  const storedCount = Number(store?.storeTotalProducts || 0);
  if (storedCount > 0) return storedCount;
  return getActiveProductCountByShop(shop, store?.activeMirrorBatchId);
}

function buildProductSyncTruth({ store, latestSync, latestCompletedSync, productCount, mirrorReady }) {
  const safeProductCount = Number(productCount || 0);
  const hasActiveMirror = Boolean(store?.activeMirrorBatchId);
  const hasCompletedSync = latestCompletedSync?.status === "completed";
  const productsSynced =
    hasActiveMirror &&
    (
      hasCompletedSync ||
      store?.shopifyBulkJobCompleted === true ||
      Boolean(store?.lastProductSyncAt)
    );

  return {
    productCount: safeProductCount,
    productsSynced,
    syncNeeded: !hasActiveMirror,
    mirrorReady: Boolean(mirrorReady) && hasActiveMirror,
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
  const storeState = normalizeStoreSyncState(store);

  return {
    isCollectionSyncing: storeState.isCollectionSyncing,
    lastCollectionSyncAt: storeState.lastCollectionSyncAt,
    mirrorHealthState: storeState.mirrorHealthState,
    staleReason: storeState.staleReason,
    repairRequired: storeState.repairRequired,
    mirrorUnsafeSince: storeState.mirrorUnsafeSince,
    lastFullSyncAt: storeState.lastFullSyncAt,
    lastIncrementalSyncAt: storeState.lastIncrementalSyncAt,
    lastWebhookProcessedAt: storeState.lastWebhookProcessedAt,
    lastReconcileAt: storeState.lastReconcileAt,
    lastInventoryReconcileAt: storeState.lastInventoryReconcileAt,
    lastCollectionReconcileAt: storeState.lastCollectionReconcileAt,
    lastSyncErrorSummary: storeState.lastSyncErrorSummary,
    syncProgressStage: storeState.syncProgressStage,
    isProductTypeSyncing: storeState.isProductTypeSyncing,
    lastProductTypeSyncAt: storeState.lastProductTypeSyncAt,
    isProductInitialySyning: storeState.isProductInitialySyning,
    productInitialSyncProgress: storeState.productInitialSyncProgress,
    shopifyBulkJobCompleted: storeState.shopifyBulkJobCompleted,
    storeTotalProducts: storeState.storeTotalProducts,
    isProductSyncing: storeState.isProductSyncing,
    lastProductSyncAt: storeState.lastProductSyncAt,
    productSyncStartedAt: storeState.productSyncStartedAt,
    activeMirrorBatchId: storeState.activeMirrorBatchId,
    latestSync,
    ...buildProductSyncTruth({
      store: storeState,
      latestSync,
      latestCompletedSync,
      productCount,
      mirrorReady: Boolean(store),
    }),
  };
}

function toSyncStatusSummaryDto(store, latestSync, latestCompletedSync, productCount) {
  const storeState = normalizeStoreSyncState(store);

  return {
    syncProgressStage: storeState.syncProgressStage,
    isProductInitialySyning: storeState.isProductInitialySyning,
    shopifyBulkJobCompleted: storeState.shopifyBulkJobCompleted,
    storeTotalProducts: storeState.storeTotalProducts,
    isProductSyncing: storeState.isProductSyncing,
    lastProductSyncAt: storeState.lastProductSyncAt,
    productSyncStartedAt: storeState.productSyncStartedAt,
    activeMirrorBatchId: storeState.activeMirrorBatchId,
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
    ...buildProductSyncTruth({
      store: storeState,
      latestSync,
      latestCompletedSync,
      productCount,
      mirrorReady: Boolean(store),
    }),
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

  const [latestSync, latestCompletedSync] = await Promise.all([
    getLatestProductSyncByShop(shop),
    getLatestCompletedProductSyncByShop(shop),
  ]);
  const productCount = await resolveActiveProductCount(shop, store);

  const syncDetails = toSyncStatusDetailDto(store, latestSync, latestCompletedSync, productCount);
  if (store && !isActiveStoreSyncState(store)) {
    await setCache(cacheKey, syncDetails, 300);
  }

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
  const activeSync = isActiveStoreSyncState(store);

  const productCount = await resolveActiveProductCount(shop, store);
  const syncSummary = toSyncStatusSummaryDto(store, latestSync, latestCompletedSync, productCount);
  if (store && !activeSync) {
    await setCache(cacheKey, syncSummary, 60);
  }

  return {
    success: true,
    shop,
    syncStatus: syncSummary,
  };
}

export async function getTrackedProductSyncStatus({ session, shop }) {
  await ensureStoreForShop({
    shop,
    accessToken: session?.accessToken,
    scope: session?.scope,
  });
  await recoverStaleProductSyncStateByShop(shop);
  const storeDetails = await getStoreTrackedProductSyncByShop(shop);

  if (!storeDetails) {
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
  }

  const latestSync = await getLatestProductSyncByShop(shop);

  const totalProducts = storeDetails.storeTotalProducts || 0;

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

  if (
    storeDetails.isProductSyncing === false &&
    storeDetails.isProductInitialySyning === false
  ) {
    if (!storeDetails.activeMirrorBatchId) {
      return {
        success: false,
        message:
          storeDetails.lastSyncErrorSummary ||
          "No active product mirror is available. Run product sync to load products.",
        status: "sync_needed",
        stage: "IDLE",
        totalProducts,
        processedProducts: 0,
        progress: 0,
      };
    }

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
