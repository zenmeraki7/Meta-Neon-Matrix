import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../../../hooks/useApiClient";

export default function useProducts({ cursor = null, filterParams = [] } = {}) {
  const api = useApiClient();

  const limit = 20;
  const normalizedFilters = useMemo(
    () =>
      filterParams.map((filter) => ({
        field: filter.field,
        operator: filter.operator,
        value: filter.value,
      })),
    [filterParams],
  );

  const query = useQuery({
    queryKey: ["products", { cursor, filterParams: normalizedFilters, limit }],
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
