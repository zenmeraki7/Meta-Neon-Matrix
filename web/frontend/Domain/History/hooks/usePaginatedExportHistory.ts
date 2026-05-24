// web/frontend/Domain/History/hooks/usePaginatedExportHistory.ts
import { useState, useEffect, useRef, useCallback } from "react";
import { ExportHistoryItem, ExportResponseSchema } from "../schema/exportHistorySchema";
import { useAuthenticatedFetch } from "../../../hooks/useAuthenticatedFetch";
import { backoff } from "../../../utils/exponentialBackoff";

interface PaginatedExportHistoryResult {
  histories: ExportHistoryItem[];
  loading: boolean;
  error?: Error;
  hasNextPage: boolean;
  loadNextPage: () => void;
  startPolling: () => void;
  stopPolling: () => void;
}

interface QueryParams {
  cursor?: string;
  limit?: number;
}

interface CursorResponse {
  data: ExportHistoryItem[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
}

export function usePaginatedExportHistory(
  initialLimit: number = 20,
  pollIntervalMs: number = 30_000,
): PaginatedExportHistoryResult {
  const fetchWithAuth = useAuthenticatedFetch();

  const [histories, setHistories] = useState<ExportHistoryItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasNextPage, setHasNextPage] = useState<boolean>(false);

  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const abortControllerRef = useRef<AbortController>(new AbortController());

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
      abortControllerRef.current.abort();
    };
  }, []);

  const fetchPage = useCallback(
    async (params: QueryParams): Promise<CursorResponse> => {
      const maxRetries = 3;
      const baseDelayMs = 1000;

      abortControllerRef.current.abort();
      abortControllerRef.current = new AbortController();

      return backoff(async () => {
        const query = new URLSearchParams();
        if (params.cursor) query.set("cursor", params.cursor);
        query.set("limit", String(params.limit ?? initialLimit));

        const response = await fetchWithAuth(`/api/history/get-shop-exporthistory?${query.toString()}`, {
          signal: abortControllerRef.current.signal,
        });

        if (!response) {
          throw new Error("Network request failed - no response received");
        }

        if (!response.ok) {
          throw new Error(`API returned status ${response.status}`);
        }

        const json = await response.json();
        const parsed = ExportResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error("Malformed response: " + JSON.stringify(parsed.error.errors));
        }

        return {
          data: parsed.data.data || [],
          pageInfo: parsed.data.meta?.pageInfo || { hasNextPage: false, endCursor: null },
        };
      }, { retries: maxRetries, factor: 2, baseDelay: baseDelayMs });
    },
    [fetchWithAuth, initialLimit],
  );

  const loadPage = useCallback(
    async (nextCursor?: string) => {
      setLoading(true);
      setError(undefined);

      try {
        const pageData = await fetchPage({ cursor: nextCursor, limit: initialLimit });
        if (!isMountedRef.current) return;

        setHistories((prev) => [...prev, ...pageData.data]);
        setCursor(pageData.pageInfo.endCursor || undefined);
        setHasNextPage(Boolean(pageData.pageInfo.hasNextPage));
      } catch (err: any) {
        if (err.name !== "AbortError") {
          setError(err);
        }
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    },
    [fetchPage, initialLimit],
  );

  useEffect(() => {
    loadPage(undefined);
  }, [loadPage]);

  const loadNextPage = useCallback(() => {
    if (hasNextPage && !loading) {
      loadPage(cursor);
    }
  }, [hasNextPage, loading, loadPage, cursor]);

  const startPolling = useCallback(() => {
    if (pollingRef.current) return;
    pollingRef.current = setInterval(() => {
      if (!isMountedRef.current) return;
      setHistories([]);
      setCursor(undefined);
      loadPage(undefined);
    }, pollIntervalMs);
  }, [loadPage, pollIntervalMs]);

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  return {
    histories,
    loading,
    error,
    hasNextPage,
    loadNextPage,
    startPolling,
    stopPolling,
  };
}
