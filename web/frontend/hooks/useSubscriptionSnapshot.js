import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "./useApiClient";

export const SUBSCRIPTION_SNAPSHOT_QUERY_KEY = [
  "subscription-plan-snapshot",
];

export function useSubscriptionSnapshot({ enabled = true } = {}) {
  const api = useApiClient();

  return useQuery({
    queryKey: SUBSCRIPTION_SNAPSHOT_QUERY_KEY,
    queryFn: ({ signal }) =>
      api.get("/api/subscription/get-plans", { signal }),
    enabled,
    staleTime: 30_000,
  });
}
