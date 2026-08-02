import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";
import { ALL_FILTERS } from "../constants";

export function normalizeRegistryData(data, { allowFallback = true } = {}) {
  if (!data || !Array.isArray(data.fields)) {
    if (!allowFallback) {
      throw new Error("Malformed product filter registry response");
    }

    return {
      fields: ALL_FILTERS,
      versions: null,
      isMalformedResponse: true,
    };
  }

  const map = new Map();

  for (const field of data.fields) {
    if (!field || typeof field.key !== "string" || field.key.trim() === "") {
      throw new Error("Filter registry contains a field without a valid key");
    }

    if (map.has(field.key)) {
      throw new Error(`Duplicate filter registry key: ${field.key}`);
    }

    map.set(field.key, field);
  }

  return {
    fields: data.fields,
    versions: data.versions ?? null,
    isMalformedResponse: false,
  };
}

export function useFilterRegistry(options = {}) {
  const api = useApiClient();
  const normalizedInitialData = useMemo(() => {
    return options.initialData
      ? normalizeRegistryData(options.initialData, { allowFallback: true })
      : undefined;
  }, [options.initialData]);
  const initialDataUpdatedAt = options.initialDataUpdatedAt ?? 0;
  const queryEnabled = options.enabled ?? true;

  const registryQuery = useQuery({
    queryKey: ["product-filter-registry"],
    enabled: queryEnabled,
    queryFn: async ({ signal }) => {
      const response = await api.get("/api/products/filter-registry", {
        signal,
      });

      return normalizeRegistryData(response?.data, {
        allowFallback: false,
      });
    },
    staleTime: 10 * 60 * 1000,
    initialData: normalizedInitialData,
    initialDataUpdatedAt,
    retry: 1,
  });

  const registry = registryQuery.data ?? {
    fields: ALL_FILTERS,
    versions: null,
    isMalformedResponse: true,
  };

  const fallbackReason = registryQuery.isError
    ? "error"
    : registry.isMalformedResponse
      ? "malformed"
      : !registryQuery.data
        ? "loading"
        : null;

  const filterByKey = useMemo(() => {
    const map = new Map();

    for (const field of registry.fields) {
      if (!field || typeof field.key !== "string" || field.key.trim() === "") {
        continue;
      }

      map.set(field.key, field);
    }

    return map;
  }, [registry.fields]);

  const getFilterByKey = useCallback(
    (key) => filterByKey.get(key) ?? null,
    [filterByKey]
  );

  return useMemo(
    () => ({
      filters: registry.fields,
      versions: registry.versions,
      getFilterByKey,

      isLoading: registryQuery.isLoading,
      isFetching: registryQuery.isFetching,
      isError: registryQuery.isError,
      error: registryQuery.error,

      isFallback: Boolean(fallbackReason),
      fallbackReason,

      refetch: registryQuery.refetch,
    }),
    [
      getFilterByKey,
      registry.fields,
      registry.versions,
      registryQuery.isLoading,
      registryQuery.isFetching,
      registryQuery.isError,
      registryQuery.error,
      registryQuery.refetch,
      fallbackReason,
    ]
  );
}
