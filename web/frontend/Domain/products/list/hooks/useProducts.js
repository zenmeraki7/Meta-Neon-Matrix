import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";

export function canonicalizeFilters(filters = []) {
  return [...filters]
    .map((filter) => ({
      field: String(filter?.field || ""),
      operator: String(filter?.operator || ""),
      value: filter?.value == null ? "" : String(filter.value),
    }))
    .sort((a, b) => {
      const byField = a.field.localeCompare(b.field);
      if (byField !== 0) return byField;
      const byOperator = a.operator.localeCompare(b.operator);
      if (byOperator !== 0) return byOperator;
      return a.value.localeCompare(b.value);
    });
}

export function buildCanonicalFilterHash(filters = []) {
  return JSON.stringify(canonicalizeFilters(filters));
}

function markPerf(event, detail = {}) {
  if (typeof window === "undefined" || typeof performance === "undefined") {
    return;
  }
  const key = `metamatrix:${event}`;
  performance.mark(key);
  if (window.__MM_PERF__) {
    window.__MM_PERF__.push({
      event,
      at: Date.now(),
      detail,
    });
  } else {
    window.__MM_PERF__ = [{ event, at: Date.now(), detail }];
  }
}

function shouldSkipPrefetchForNetworkBudget() {
  if (typeof navigator === "undefined") return false;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return false;

  if (connection.saveData === true) {
    return true;
  }

  const effectiveType = String(connection.effectiveType || "").toLowerCase();
  return effectiveType === "slow-2g" || effectiveType === "2g";
}

function toStableRowId(product, index) {
  const id = String(product?.id || "").trim();
  if (id) return id;
  const handle = String(product?.handle || "").trim();
  if (handle) return `handle:${handle}:${index}`;
  const title = String(product?.title || "").trim();
  const vendor = String(product?.vendor || "").trim();
  const productType = String(product?.productType || "").trim();
  return `derived:${title}|${vendor}|${productType}|${index}`;
}

export default function useProducts({
  cursor = null,
  filterParams = [],
  filterHash = "[]",
  cursorFilterHash = null,
  initialData = undefined,
  enabled = true,
} = {}) {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const shop =
    typeof window !== "undefined"
      ? String(window?.shopify?.config?.shop || window?.Shopify?.shop || "unknown")
      : "unknown";

  const limit = 20;
  const normalizedFilters = useMemo(() => canonicalizeFilters(filterParams), [filterParams]);
  const filtersKey = useMemo(() => buildCanonicalFilterHash(normalizedFilters), [normalizedFilters]);
  const resolvedFilterHash = String(filterHash || filtersKey);
  const isCursorHashMismatch =
    Boolean(cursor) &&
    Boolean(cursorFilterHash) &&
    String(cursorFilterHash) !== resolvedFilterHash;

  const safeCursor = isCursorHashMismatch ? null : cursor;

  const query = useQuery({
    queryKey: ["products", shop, safeCursor || null, limit, resolvedFilterHash],
    enabled,
    initialData,
    staleTime: 10_000,
    queryFn: async ({ signal }) => {
      if (isCursorHashMismatch) {
        markPerf("products_cursor_hash_mismatch", {
          shop,
          cursorFilterHash,
          filterHash: resolvedFilterHash,
        });
      }

      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (safeCursor) {
        params.set("cursor", safeCursor);
      }
      markPerf("products_fetch_start", {
        shop,
        cursor: safeCursor,
        filterHash: resolvedFilterHash,
      });

      const json = await api.post(
        `/api/products/get-all?${params.toString()}`,
        { filterParams: normalizedFilters },
        { signal },
      );
      markPerf("products_fetch_end", {
        shop,
        cursor: safeCursor,
        filterHash: resolvedFilterHash,
      });

      const products = Array.isArray(json?.data?.products)
        ? json.data.products.map((product, index) => ({
            ...product,
            __rowId: toStableRowId(product, index),
          }))
        : [];

      return {
        products,
        pagination: json?.data?.pagination || null,
        count:
          json?.data?.pagination?.total ??
          products.length ??
          0,
        unavailableReason: json?.data?.unavailableReason || null,
        mirrorHealth: json?.data?.mirrorHealth || null,
      };
    },
    placeholderData: (previousData) => previousData,
  });

  useEffect(() => {
    if (!enabled) return;
    if (isCursorHashMismatch) return;
    if (shouldSkipPrefetchForNetworkBudget()) {
      markPerf("products_prefetch_skipped_network_budget", { shop });
      return;
    }

    const pageInfo = query.data?.pagination || null;
    const hasNextPage = Boolean(pageInfo?.hasNextPage);
    const endCursor = String(pageInfo?.endCursor || "").trim();
    if (!hasNextPage || !endCursor) return;

    const nextQueryKey = ["products", shop, endCursor, limit, resolvedFilterHash];

    // Warm the next sequential cursor page for near-zero-latency pagination clicks.
    void queryClient.prefetchQuery({
      queryKey: nextQueryKey,
      staleTime: 10_000,
      queryFn: async ({ signal }) => {
        markPerf("products_prefetch_start", {
          shop,
          cursor: endCursor,
          filterHash: resolvedFilterHash,
        });

        const params = new URLSearchParams();
        params.set("limit", String(limit));
        params.set("cursor", endCursor);
        const json = await api.post(
          `/api/products/get-all?${params.toString()}`,
          { filterParams: normalizedFilters },
          { signal },
        );

        const products = Array.isArray(json?.data?.products)
          ? json.data.products.map((product, index) => ({
              ...product,
              __rowId: toStableRowId(product, index),
            }))
          : [];

        markPerf("products_prefetch_end", {
          shop,
          cursor: endCursor,
          filterHash: resolvedFilterHash,
        });

        return {
          products,
          pagination: json?.data?.pagination || null,
          count: json?.data?.pagination?.total ?? products.length ?? 0,
        };
      },
    });
  }, [
    api,
    enabled,
    isCursorHashMismatch,
    limit,
    normalizedFilters,
    query.data?.pagination,
    queryClient,
    resolvedFilterHash,
    shop,
  ]);

  return {
    products: query.data?.products || [],
    pagination: query.data?.pagination || null,
    totalCount: query.data?.count || 0,
    unavailableReason: query.data?.unavailableReason || null,
    mirrorHealth: query.data?.mirrorHealth || null,
    loading: query.isLoading,
    error: query.error?.message || null,
    hasFetched: query.isFetched,
    refetch: query.refetch,
  };
}
