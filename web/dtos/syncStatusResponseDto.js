function toLatestSyncDto(latestSync) {
  if (!latestSync || typeof latestSync !== "object") return null;

  return {
    id: latestSync.id ?? null,
    status: latestSync.status ?? null,
    stage: latestSync.stage ?? null,
    updatedAt: latestSync.updatedAt ?? null,
    errorMessage: latestSync.errorMessage ?? null,
    isInitialProductSync: Boolean(latestSync.isInitialProductSync),
  };
}

function toSyncStatusDetailPayloadDto(syncStatus = {}) {
  return {
    isCollectionSyncing: Boolean(syncStatus.isCollectionSyncing),
    lastCollectionSyncAt: syncStatus.lastCollectionSyncAt ?? null,
    mirrorHealthState: syncStatus.mirrorHealthState ?? null,
    staleReason: syncStatus.staleReason ?? null,
    repairRequired: Boolean(syncStatus.repairRequired),
    mirrorUnsafeSince: syncStatus.mirrorUnsafeSince ?? null,
    lastFullSyncAt: syncStatus.lastFullSyncAt ?? null,
    lastIncrementalSyncAt: syncStatus.lastIncrementalSyncAt ?? null,
    lastWebhookProcessedAt: syncStatus.lastWebhookProcessedAt ?? null,
    lastReconcileAt: syncStatus.lastReconcileAt ?? null,
    lastInventoryReconcileAt: syncStatus.lastInventoryReconcileAt ?? null,
    lastCollectionReconcileAt: syncStatus.lastCollectionReconcileAt ?? null,
    lastSyncErrorSummary: syncStatus.lastSyncErrorSummary ?? null,
    syncProgressStage: syncStatus.syncProgressStage ?? null,
    isProductTypeSyncing: Boolean(syncStatus.isProductTypeSyncing),
    lastProductTypeSyncAt: syncStatus.lastProductTypeSyncAt ?? null,
    isProductInitialySyning: Boolean(syncStatus.isProductInitialySyning),
    productInitialSyncProgress: Number(syncStatus.productInitialSyncProgress || 0),
    shopifyBulkJobCompleted: Boolean(syncStatus.shopifyBulkJobCompleted),
    storeTotalProducts: Number(syncStatus.storeTotalProducts || 0),
    isProductSyncing: Boolean(syncStatus.isProductSyncing),
    lastProductSyncAt: syncStatus.lastProductSyncAt ?? null,
    activeMirrorBatchId: syncStatus.activeMirrorBatchId ?? null,
    latestSync: toLatestSyncDto(syncStatus.latestSync),
  };
}

function toSyncStatusSummaryPayloadDto(syncStatus = {}) {
  return {
    mirrorHealthState: syncStatus.mirrorHealthState ?? null,
    staleReason: syncStatus.staleReason ?? null,
    repairRequired: Boolean(syncStatus.repairRequired),
    mirrorUnsafeSince: syncStatus.mirrorUnsafeSince ?? null,
    lastSyncErrorSummary: syncStatus.lastSyncErrorSummary ?? null,
    lastFullSyncAt: syncStatus.lastFullSyncAt ?? null,
    syncProgressStage: syncStatus.syncProgressStage ?? null,
    isProductInitialySyning: Boolean(syncStatus.isProductInitialySyning),
    shopifyBulkJobCompleted: Boolean(syncStatus.shopifyBulkJobCompleted),
    storeTotalProducts: Number(syncStatus.storeTotalProducts || 0),
    isProductSyncing: Boolean(syncStatus.isProductSyncing),
    lastProductSyncAt: syncStatus.lastProductSyncAt ?? null,
    activeMirrorBatchId: syncStatus.activeMirrorBatchId ?? null,
    activeProductRowCount: Number(syncStatus.activeProductRowCount || 0),
    productCount: Number(syncStatus.productCount || 0),
    hasActiveProductMirrorRows: Boolean(syncStatus.hasActiveProductMirrorRows),
    mirrorReady: Boolean(syncStatus.mirrorReady),
    latestBatchId: syncStatus.latestBatchId ?? null,
    stage: syncStatus.stage ?? null,
    syncInProgress: Boolean(syncStatus.syncInProgress),
    canPreviewProducts: Boolean(syncStatus.canPreviewProducts),
    latestSync: toLatestSyncDto(syncStatus.latestSync),
  };
}

export function toSyncStatusDetailDto(result = {}) {
  return {
    success: Boolean(result.success),
    shop: result.shop ?? null,
    syncStatus: toSyncStatusDetailPayloadDto(result.syncStatus),
  };
}

export function toSyncStatusSummaryDto(result = {}) {
  return {
    success: Boolean(result.success),
    shop: result.shop ?? null,
    syncStatus: toSyncStatusSummaryPayloadDto(result.syncStatus),
  };
}

export function toTrackedSyncStatusDto(result = {}) {
  return {
    success: Boolean(result.success),
    message: String(result.message || ""),
    status: String(result.status || "idle"),
    stage: String(result.stage || "IDLE"),
    totalProducts: Number(result.totalProducts || 0),
    processedProducts: Number(result.processedProducts || 0),
    progress: Number(result.progress || 0),
  };
}

