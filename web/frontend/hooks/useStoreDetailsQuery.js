import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "./useApiClient";

export function useStoreDetailsQuery() {
  const api = useApiClient();

  return useQuery({
    queryKey: ["store-details"],
    queryFn: ({ signal }) => api.get("/api/store/details", { signal }),
    staleTime: 30 * 1000,
  });
}
