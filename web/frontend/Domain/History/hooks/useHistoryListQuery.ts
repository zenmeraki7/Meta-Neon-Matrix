import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { historyService } from "../services/historyService";

export interface HistoryRecord {
  [key: string]: unknown;
}

export interface HistoryPageInfoSource {
  hasNextPage?: boolean | null;
  nextCursor?: string | null;
  endCursor?: string | null;
}

export interface HistoryListResponse {
  items?: HistoryRecord[];
  data?: HistoryRecord[];
  pageInfo?: HistoryPageInfoSource | null;
  meta?: {
    pageInfo?: HistoryPageInfoSource | null;
  } | null;
}

export interface HistoryListQueryOptions {
  query?: Record<string, unknown>;
  cursor?: string | null;
  lang?: string;
}

function normalizeHistoryQuery(query: Record<string, unknown> = {}) {
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

export function useHistoryListQuery({
  query,
  cursor,
  lang,
}: HistoryListQueryOptions): UseQueryResult<HistoryListResponse, unknown> {
  const normalizedQuery = normalizeHistoryQuery(query);
  const normalizedQueryKey = JSON.stringify(normalizedQuery);

  return useQuery({
    queryKey: ["history-list", lang || "en", cursor || null, normalizedQueryKey],
    queryFn: ({ signal }) =>
      historyService.getHistories(
        { ...normalizedQuery, cursor: cursor || null, lang: lang || "en" },
        signal,
      ) as Promise<HistoryListResponse>,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
}
