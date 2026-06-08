import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";

const DEFAULT_PRODUCTS_PAGE_SIZE = 50;
const MAX_PRODUCTS_PAGE_SIZE = 50;
const PERF_BUFFER_LIMIT = 200;

function stableValue(value) {
  if (value === undefined || value === null) return null;

  if (Array.isArray(value)) {
    return value.map(stableValue).sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }

  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableValue(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function stableValueKey(value) {
  return JSON.stringify(stableValue(value));
}

export function canonicalizeFilters(filters = []) {
  return [...filters]
    .map((filter) => ({
      field: String(filter?.field ?? ""),
      operator: String(filter?.operator ?? ""),
      value: stableValue(filter?.value),
    }))
    .sort((a, b) => {
      const byField = a.field.localeCompare(b.field);
      if (byField !== 0) return byField;

      const byOperator = a.operator.localeCompare(b.operator);
      if (byOperator !== 0) return byOperator;

      return stableValueKey(a.value).localeCompare(stableValueKey(b.value));
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

  try {
    performance.clearMarks(key);
    performance.mark(key);
  } catch {
    // Diagnostic only. Never break product loading.
  }

  const entry = {
    event,
    at: Date.now(),
    detail,
  };

  const buffer = Array.isArray(window.__MM_PERF__) ? window.__MM_PERF__ : [];
  buffer.push(entry);

  if (buffer.length > PERF_BUFFER_LIMIT) {
    buffer.splice(0, buffer.length - PERF_BUFFER_LIMIT);
  }

  window.__MM_PERF__ = buffer;
}

function shouldSkipPrefetchForNetworkBudget() {
  if (typeof navigator === "undefined") return false;

  const connection =
    navigator.connection ||
    navigator.mozConnection ||
    navigator.webkitConnection;

  if (!connection) return false;

  if (connection.saveData === true) return true;

  const effectiveType = String(connection.effectiveType || "").toLowerCase();

  return effectiveType === "slow-2g" || effectiveType === "2g";
}

function toStableRowId(product) {
  const id =
    product?.shopifyProductId ||
    product?.adminGraphqlApiId ||
    product?.gid ||
    product?.id;

  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function normalizeProductsPayload(data) {
  const payload = data?.data && typeof data.data === "object" ? data.data : data;
  const rawProducts = Array.isArray(payload?.products) ? payload.products : [];
  let droppedRows = 0;

  const products = rawProducts
    .map((product) => {
      const rowId = toStableRowId(product);

      if (!rowId) {
        droppedRows += 1;
        return null;
      }

      return {
        ...product,
        __rowId: rowId,
      };
    })
    .filter(Boolean);

  return {
    products,
    pagination: payload?.pagination || null,
    count: Number(payload?.pagination?.total ?? payload?.count ?? products.length) || 0,
    unavailableReason: payload?.unavailableReason || null,
    mirrorHealth: payload?.mirrorHealth || null,
    droppedRows,
  };
}

function normalizeInitialData(initialData) {
  return initialData ? normalizeProductsPayload(initialData) : undefined;
}

export default function useProducts({
  cursor = null,
  filterParams = [],
  cursorFilterHash = null,
  initialData = undefined,
  enabled = true,
  limit = DEFAULT_PRODUCTS_PAGE_SIZE,
} = {}) {
  const api = useApiClient();
  const queryClient = useQueryClient();

  const pageSize = Math.min(
    Math.max(Number(limit) || DEFAULT_PRODUCTS_PAGE_SIZE, 1),
    MAX_PRODUCTS_PAGE_SIZE,
  );

  const normalizedFilters = useMemo(
    () => canonicalizeFilters(filterParams),
    [filterParams],
  );

  const resolvedFilterHash = useMemo(
    () => buildCanonicalFilterHash(normalizedFilters),
    [normalizedFilters],
  );

  const isCursorHashMismatch =
    Boolean(cursor) && String(cursorFilterHash || "") !== resolvedFilterHash;

  const safeCursor = isCursorHashMismatch ? null : cursor;

  const normalizedInitialData = useMemo(
    () => normalizeInitialData(initialData),
    [initialData],
  );

  const query = useQuery({
    queryKey: ["products", safeCursor || null, pageSize, resolvedFilterHash],
    enabled,
    initialData: normalizedInitialData,
    initialDataUpdatedAt: normalizedInitialData ? Date.now() : undefined,
    staleTime: 10_000,
    queryFn: async ({ signal }) => {
      if (isCursorHashMismatch) {
        markPerf("products_cursor_hash_mismatch", {
          cursorFilterHash,
          filterHash: resolvedFilterHash,
        });
      }

      const params = new URLSearchParams();
      params.set("limit", String(pageSize));

      if (safeCursor) {
        params.set("cursor", safeCursor);
      }

      markPerf("products_fetch_start", {
        cursor: safeCursor,
        filterHash: resolvedFilterHash,
      });

      const json = await api.post(
        `/api/products/get-all?${params.toString()}`,
        { filterParams: normalizedFilters },
        { signal },
      );

      markPerf("products_fetch_end", {
        cursor: safeCursor,
        filterHash: resolvedFilterHash,
      });

      const normalized = normalizeProductsPayload(json);

      if (normalized.droppedRows > 0) {
        markPerf("products_rows_dropped_missing_stable_id", {
          droppedRows: normalized.droppedRows,
          filterHash: resolvedFilterHash,
        });
      }

      return normalized;
    },
    placeholderData: (previousData) => previousData,
  });

  useEffect(() => {
    if (!enabled) return;
    if (isCursorHashMismatch) return;

    if (shouldSkipPrefetchForNetworkBudget()) {
      markPerf("products_prefetch_skipped_network_budget");
      return;
    }

    if (normalizedFilters.length > 3) {
      markPerf("products_prefetch_skipped_filter_complexity", {
        filterCount: normalizedFilters.length,
      });
      return;
    }

    if (query.data?.unavailableReason) {
      markPerf("products_prefetch_skipped_unavailable", {
        unavailableReason: query.data.unavailableReason,
      });
      return;
    }

    if (query.data?.mirrorHealth?.status === "degraded") {
      markPerf("products_prefetch_skipped_mirror_degraded");
      return;
    }

    const pageInfo = query.data?.pagination || null;
    const hasNextPage = Boolean(pageInfo?.hasNextPage);
    const endCursor = String(pageInfo?.endCursor || "").trim();

    if (!hasNextPage || !endCursor) return;

    const nextQueryKey = [
      "products",
      endCursor,
      pageSize,
      resolvedFilterHash,
    ];

    void queryClient.prefetchQuery({
      queryKey: nextQueryKey,
      staleTime: 10_000,
      queryFn: async ({ signal }) => {
        markPerf("products_prefetch_start", {
          cursor: endCursor,
          filterHash: resolvedFilterHash,
        });

        const params = new URLSearchParams();
        params.set("limit", String(pageSize));
        params.set("cursor", endCursor);

        const json = await api.post(
          `/api/products/get-all?${params.toString()}`,
          { filterParams: normalizedFilters },
          { signal },
        );

        markPerf("products_prefetch_end", {
          cursor: endCursor,
          filterHash: resolvedFilterHash,
        });

        return normalizeProductsPayload(json);
      },
    });
  }, [
    api,
    enabled,
    isCursorHashMismatch,
    normalizedFilters,
    pageSize,
    query.data?.mirrorHealth?.status,
    query.data?.pagination,
    query.data?.unavailableReason,
    queryClient,
    resolvedFilterHash,
  ]);

  return {
    products: query.data?.products || [],
    pagination: query.data?.pagination || null,
    totalCount: query.data?.count || 0,
    unavailableReason: query.data?.unavailableReason || null,
    mirrorHealth: query.data?.mirrorHealth || null,
    droppedRows: query.data?.droppedRows || 0,

    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error?.message || null,
    errorObject: query.error || null,
    hasFetched: query.isFetched,
    refetch: query.refetch,

    filterHash: resolvedFilterHash,
  };
}
