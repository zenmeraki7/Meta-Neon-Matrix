import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "./useApiClient";

export function useStoreDetailsQuery(options = {}) {
  const api = useApiClient();
  const initialData = options?.initialData;

  return useQuery({
    queryKey: ["store-details"],
    queryFn: ({ signal }) => api.get("/api/store/details", { signal }),
    staleTime: 30 * 1000,
    initialData: initialData || undefined,
    enabled: options?.enabled ?? true,
  });
}
