import { prisma } from "../config/database.js";
import { getBulkEditStatus } from "../utils/bulkOperationHelper.js";
import { getCache, setCache } from "../utils/cacheUtils.js";

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

function toSyncStatusSummaryDto(store, latestSync) {
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
  };
}

export async function getSyncStatusDetailForShop(shop) {
  const cacheKey = `${shop}:sync_details`;
  const cached = await getCache(cacheKey);
  if (cached) {
    return {
      success: true,
      shop,
      syncStatus: cached,
    };
  }

  const store = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: {
      mirrorHealthState: true,
      staleReason: true,
      repairRequired: true,
      mirrorUnsafeSince: true,
      lastFullSyncAt: true,
      lastIncrementalSyncAt: true,
      lastWebhookProcessedAt: true,
      lastReconcileAt: true,
      lastInventoryReconcileAt: true,
      lastCollectionReconcileAt: true,
      lastSyncErrorSummary: true,
      syncProgressStage: true,
      isCollectionSyncing: true,
      lastCollectionSyncAt: true,
      isProductTypeSyncing: true,
      lastProductTypeSyncAt: true,
      isProductInitialySyning: true,
      productInitialSyncProgress: true,
      shopifyBulkJobCompleted: true,
      storeTotalProducts: true,
      isProductSyncing: true,
      lastProductSyncAt: true,
      activeMirrorBatchId: true,
    },
  });

  if (!store) {
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
  }

  const latestSync = await prisma.syncHistory.findFirst({
    where: {
      shop,
      operationType: "Product",
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      bulkOperationId: true,
      syncBatchId: true,
      status: true,
      stage: true,
      recordCount: true,
      updatedAt: true,
      errorMessage: true,
      isInitialProductSync: true,
    },
  });

  const syncDetails = toSyncStatusDetailDto(store, latestSync);
  await setCache(cacheKey, syncDetails, 300);

  return {
    success: true,
    shop,
    syncStatus: syncDetails,
  };
}

export async function getSyncStatusSummaryForShop(shop) {
  const cacheKey = `${shop}:sync_summary`;
  const cached = await getCache(cacheKey);
  if (cached) {
    return {
      success: true,
      shop,
      syncStatus: cached,
    };
  }

  const [store, latestSync] = await Promise.all([
    prisma.store.findUnique({
      where: { shopUrl: shop },
      select: {
        syncProgressStage: true,
        isProductInitialySyning: true,
        shopifyBulkJobCompleted: true,
        storeTotalProducts: true,
        isProductSyncing: true,
        lastProductSyncAt: true,
        activeMirrorBatchId: true,
      },
    }),
    prisma.syncHistory.findFirst({
      where: {
        shop,
        operationType: "Product",
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        stage: true,
        updatedAt: true,
        errorMessage: true,
        isInitialProductSync: true,
      },
    }),
  ]);

  if (!store) {
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
  }

  const syncSummary = toSyncStatusSummaryDto(store, latestSync);
  await setCache(cacheKey, syncSummary, 60);

  return {
    success: true,
    shop,
    syncStatus: syncSummary,
  };
}

export async function getTrackedProductSyncStatus({ session, shop }) {
  const storeDetails = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: {
      isProductInitialySyning: true,
      isProductSyncing: true,
      productInitialSyncProgress: true,
      shopifyBulkJobCompleted: true,
      storeTotalProducts: true,
      syncProgressStage: true,
      lastSyncErrorSummary: true,
    },
  });

  if (!storeDetails) {
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
  }

  const latestSync = await prisma.syncHistory.findFirst({
    where: {
      shop,
      operationType: "Product",
    },
    orderBy: { createdAt: "desc" },
    select: {
      bulkOperationId: true,
      status: true,
      stage: true,
      errorMessage: true,
      isInitialProductSync: true,
    },
  });

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

