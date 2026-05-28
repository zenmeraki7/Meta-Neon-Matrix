import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";

function canonicalizeFilters(filters = []) {
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

export default function useProducts({ cursor = null, filterParams = [] } = {}) {
  const api = useApiClient();
  const shop =
    typeof window !== "undefined"
      ? String(window?.shopify?.config?.shop || window?.Shopify?.shop || "unknown")
      : "unknown";

  const limit = 20;
  const normalizedFilters = useMemo(() => canonicalizeFilters(filterParams), [filterParams]);
  const filtersKey = useMemo(() => JSON.stringify(normalizedFilters), [normalizedFilters]);

  const query = useQuery({
    queryKey: ["products", shop, cursor || null, limit, filtersKey],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (cursor) {
        params.set("cursor", cursor);
      }

      const json = await api.post(
        `/api/products/get-all?${params.toString()}`,
        { filterParams: normalizedFilters },
        { signal },
      );

      return {
        products: json?.data?.products || [],
        pagination: json?.data?.pagination || null,
        count:
          json?.data?.pagination?.total ??
          json?.data?.products?.length ??
          0,
      };
    },
    placeholderData: (previousData) => previousData,
  });

  return {
    products: query.data?.products || [],
    pagination: query.data?.pagination || null,
    totalCount: query.data?.count || 0,
    loading: query.isLoading,
    error: query.error?.message || null,
    hasFetched: query.isFetched,
    refetch: query.refetch,
  };
}
