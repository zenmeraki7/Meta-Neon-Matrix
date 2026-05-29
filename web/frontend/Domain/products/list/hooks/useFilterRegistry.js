import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";
import { ALL_FILTERS } from "../constants";

export function useFilterRegistry(options = {}) {
  const api = useApiClient();
  const initialData = options?.initialData ?? undefined;
  const registryQuery = useQuery({
    queryKey: ["product-filter-registry"],
    queryFn: async ({ signal }) => {
      const response = await api.get("/api/products/filter-registry", {
        signal,
      });
      return {
        fields: Array.isArray(response?.data?.fields)
          ? response.data.fields
          : ALL_FILTERS,
        versions: response?.data?.versions || null,
      };
    },
    staleTime: 10 * 60 * 1000,
    initialData,
  });

  const registry = registryQuery.data || {
    fields: ALL_FILTERS,
    versions: null,
  };

  const filterByKey = useMemo(() => {
    const map = new Map();
    for (const field of registry.fields) {
      map.set(field.key, field);
    }
    return map;
  }, [registry.fields]);

  return {
    filters: registry.fields,
    versions: registry.versions,
    getFilterByKey: (key) => filterByKey.get(key) || null,
  };
}
