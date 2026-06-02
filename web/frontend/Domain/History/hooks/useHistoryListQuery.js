import { useQuery } from "@tanstack/react-query";
import { historyService } from "../services/historyService";

function normalizeHistoryQuery(query = {}) {
  return {
    limit: Number(query?.limit || 20),
    search: String(query?.search || "").trim(),
    type: String(query?.type || "").trim(),
    status: String(query?.status || "").trim(),
    frequency: String(query?.frequency || "").trim(),
    sortKey: String(query?.sortKey || "createdAt"),
    sortDirection: String(query?.sortDirection || "desc"),
  };
}

export function useHistoryListQuery({ query, cursor, lang }) {
  const normalizedQuery = normalizeHistoryQuery(query);
  const normalizedQueryKey = JSON.stringify(normalizedQuery);

  return useQuery({
    queryKey: ["history-list", lang || "en", cursor || null, normalizedQueryKey],
    queryFn: ({ signal }) =>
      historyService.getHistories(
        { ...normalizedQuery, cursor: cursor || null, lang: lang || "en" },
        signal,
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
}
