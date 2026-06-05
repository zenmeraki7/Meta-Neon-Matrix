import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "./useApiClient";
import { protectedApiGet } from "../api/protectedApiClient";

const STALE_SYNC_MS = 1000 * 60 * 60; // 1 hour

const PRODUCT_TRACK_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "reauth_required",
]);

function toTimeMs(value) {
  if (!value) return null;

  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function isStaleProductSync(syncStatus) {
  if (!syncStatus) return false;

  const running =
    syncStatus.isProductSyncing === true ||
    syncStatus.isProductInitialySyning === true ||
    syncStatus.syncProgressStage === "SHOPIFY_BULK_RUNNING" ||
    syncStatus.syncProgressStage === "MIRROR_STAGING";

  if (!running) return false;

  const startedAt =
    toTimeMs(syncStatus.productSyncStartedAt) ||
    toTimeMs(syncStatus.syncStartedAt) ||
    toTimeMs(syncStatus.lastProductSyncStartedAt) ||
    toTimeMs(syncStatus.updatedAt);

  if (!startedAt) return false;

  return Date.now() - startedAt > STALE_SYNC_MS;
}

function isActiveSyncStatus(syncStatus) {
  if (!syncStatus) return false;

  if (typeof syncStatus.syncInProgress === "boolean") {
    return syncStatus.syncInProgress && !isStaleProductSync(syncStatus);
  }

  if (isStaleProductSync(syncStatus)) {
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
    typeof document === "undefined"
      ? true
      : document.visibilityState === "visible",
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

export function useSyncStatusQuery(options = {}) {
  const api = useApiClient();
  const isVisible = usePageVisibility();
  const initialData = options?.initialData ?? undefined;

  return useQuery({
    queryKey: ["sync-status"],
    queryFn: async ({ signal }) => {
      const result = await api.get("/api/sync/sync-status/summary", {
        signal,
      });

      return result?.syncStatus || null;
    },
    enabled: isVisible,
    initialData,
    refetchInterval: (query) => {
      if (!isVisible || !isActiveSyncStatus(query.state.data)) {
        return false;
      }

      const jitterMs = Math.floor(Math.random() * 750);
      return 4000 + jitterMs;
    },
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
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
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sync-status"] }),
        queryClient.invalidateQueries({ queryKey: ["product-sync-status"] }),
        queryClient.invalidateQueries({ queryKey: ["bootstrap-products"] }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: ["variants-grid"] }),
      ]);
    },
  });
}

export function useProductTrackQuery() {
  return useQuery({
    queryKey: ["product-sync-status"],
    queryFn: async ({ signal }) => {
      const data = await protectedApiGet("/api/sync/product-track", {
        signal,
      });

      return {
        progress: Number(data?.progress || 0),
        processedProducts: Number(data?.processedProducts || 0),
        totalProducts: Number(data?.totalProducts || 0),
        status: String(data?.status || "pending"),
        message: data?.message || "",
      };
    },
    staleTime: 2000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      const status = String(query.state.data?.status || "")
        .trim()
        .toLowerCase();

      if (PRODUCT_TRACK_TERMINAL_STATUSES.has(status)) {
        return false;
      }

      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return false;
      }

      const jitterMs = Math.floor(Math.random() * 750);
      return 3000 + jitterMs;
    },
  });
}

export function useSyncStatusHelpers(options = {}) {
  const query = useSyncStatusQuery(options);
  const startProductSync = useStartProductSyncMutation();

  const syncStatus = query.data || null;
  const isSyncStale = isStaleProductSync(syncStatus);
  const isSyncInProgress = isActiveSyncStatus(syncStatus);

  return {
    syncStatus,
    syncStatusLoading: query.isLoading,
    syncStatusError: query.error || null,
    isSyncInProgress,
    isSyncStale,
    refetchSyncStatus: query.refetch,
    startProductSync,
  };
}
