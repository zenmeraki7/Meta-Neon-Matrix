import { useEffect, useMemo, useState } from "react";
import { useApiClient } from "../../../../hooks/useApiClient";
import { ALL_FILTERS } from "../constants";

export function useFilterRegistry() {
  const api = useApiClient();
  const [registry, setRegistry] = useState({
    fields: ALL_FILTERS,
    versions: null,
  });

  useEffect(() => {
    let active = true;
    async function loadRegistry() {
      try {
        const response = await api.get("/api/products/filter-registry");
        if (!active) return;
        const fields = Array.isArray(response?.data?.fields)
          ? response.data.fields
          : ALL_FILTERS;
        setRegistry({
          fields,
          versions: response?.data?.versions || null,
        });
      } catch {
        if (!active) return;
        setRegistry({ fields: ALL_FILTERS, versions: null });
      }
    }
    loadRegistry();
    return () => {
      active = false;
    };
  }, [api]);

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

