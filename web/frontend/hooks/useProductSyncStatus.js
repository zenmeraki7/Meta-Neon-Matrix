import { useCallback, useEffect, useState } from "react";
import { useApiClient } from "./useApiClient";

function isActiveSyncStatus(syncStatus) {
  if (!syncStatus) {
    return false;
  }

  const hasCompletedInitialSync =
    syncStatus.shopifyBulkJobCompleted === true &&
    syncStatus.syncProgressStage === "IDLE";

  if (hasCompletedInitialSync) {
    return false;
  }

  return (
    syncStatus.isProductSyncing === true ||
    syncStatus.isProductInitialySyning === true ||
    syncStatus.syncProgressStage === "SHOPIFY_BULK_RUNNING" ||
    syncStatus.syncProgressStage === "MIRROR_STAGING"
  );
}

export default function useProductSyncStatus() {
  const api = useApiClient();
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncStatusLoading, setSyncStatusLoading] = useState(true);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const result = await api.get("/api/sync/sync-status");
      if (result?.syncStatus) {
        setSyncStatus(result.syncStatus);
      }
    } catch {
      // Keep consuming pages usable if sync status cannot be loaded.
    } finally {
      setSyncStatusLoading(false);
    }
  }, [api]);

  useEffect(() => {
    fetchSyncStatus();
  }, [fetchSyncStatus]);

  useEffect(() => {
    const isSyncRunning = isActiveSyncStatus(syncStatus);

    if (!isSyncRunning) {
      return undefined;
    }

    const interval = setInterval(fetchSyncStatus, 4000);
    return () => clearInterval(interval);
  }, [
    syncStatus?.isProductSyncing,
    syncStatus?.isProductInitialySyning,
    fetchSyncStatus,
  ]);

  return {
    syncStatus,
    syncStatusLoading,
    isSyncInProgress: isActiveSyncStatus(syncStatus),
  };
}
