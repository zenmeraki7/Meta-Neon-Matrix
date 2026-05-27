import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

function usePageVisibility() {
  const [isVisible, setIsVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onVisibilityChange = () => {
      setIsVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return isVisible;
}

export function useSyncStatusQuery() {
  const api = useApiClient();
  const isVisible = usePageVisibility();

  return useQuery({
    queryKey: ["sync-status"],
    queryFn: async ({ signal }) => {
      const result = await api.get("/api/sync/sync-status/summary", { signal });
      return result?.syncStatus || null;
    },
    enabled: isVisible,
    refetchInterval: (query) =>
      isVisible && isActiveSyncStatus(query.state.data) ? 4000 : false,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    refetchOnReconnect: true,
    staleTime: 4000,
  });
}

export function useStartProductSyncMutation() {
  const api = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ force = false } = {}) => {
      const suffix = force ? "?force=true" : "";
      return api.get(`/api/sync/products${suffix}`);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["sync-status"] });
    },
  });
}

export function useSyncStatusHelpers() {
  const query = useSyncStatusQuery();
  const startProductSync = useStartProductSyncMutation();

  const isSyncInProgress = isActiveSyncStatus(query.data);

  return {
    syncStatus: query.data || null,
    syncStatusLoading: query.isLoading,
    syncStatusError: query.error || null,
    isSyncInProgress,
    refetchSyncStatus: query.refetch,
    startProductSync,
  };
}
