import { useQuery } from "@tanstack/react-query";
import { historyService } from "../services/historyService";

function normalizeRecurringQuery(query = {}) {
  return {
    limit: Number(query?.limit || 20),
    search: String(query?.search || "").trim(),
    status: String(query?.status || "").trim(),
    frequency: String(query?.frequency || "").trim(),
    sortKey: String(query?.sortKey || "createdAt"),
    sortDirection: String(query?.sortDirection || "desc"),
  };
}

export function useRecurringHistoryQuery({ query, cursor, lang }) {
  const normalizedQuery = normalizeRecurringQuery(query);
  const normalizedQueryKey = JSON.stringify(normalizedQuery);

  return useQuery({
    queryKey: ["recurring-history-list", lang || "en", cursor || null, normalizedQueryKey],
    queryFn: ({ signal }) =>
      historyService.getRecurringEditHistories(
        { ...normalizedQuery, cursor: cursor || null, lang: lang || "en" },
        signal,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
}
