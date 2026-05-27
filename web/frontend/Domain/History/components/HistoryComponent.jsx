import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Banner, Toast, BlockStack } from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import HistoryTable from "../components/HistoryTable";
import { historyService } from "../services/historyService";
import { toSafeErrorMessage } from "../../../utils/frontendError";
import useDebouncedValue from "../../../hooks/useDebouncedValue";

const DEFAULT_QUERY = {
  limit: 20,
  search: "",
  type: "Manual edit",
  status: "",
  frequency: "",
  sortKey: "createdAt",
  sortDirection: "desc",
};

const HistoryComponent = () => {
  const { t, i18n } = useTranslation();
  const [toastState, setToastState] = useState({ active: false, message: "", error: false });
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [cursorStack, setCursorStack] = useState([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [searchDraft, setSearchDraft] = useState(DEFAULT_QUERY.search);
  const debouncedSearchDraft = useDebouncedValue(searchDraft, 400);
  const [histories, setHistories] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
  });

  const fetchHistory = useCallback(async (nextQuery) => {
    try {
      setIsLoading(true);
      setError(null);
      const cursor = cursorStack[cursorIndex] || null;
      const response = await historyService.getHistories(
        { ...nextQuery, cursor, lang: i18n.language || "en" },
        undefined,
      );
      const items = response.items || response.data || [];
      const info = response.pageInfo || response.meta?.pageInfo || {};
      setHistories(items);
      setPageInfo({
        hasNextPage: Boolean(info.hasNextPage),
        hasPreviousPage: cursorIndex > 0,
        nextCursor: info.nextCursor || info.endCursor || null,
      });
    } catch (err) {
      setError(
        toSafeErrorMessage(t, err, "common.errors.generic"),
      );
    } finally {
      setIsLoading(false);
    }
  }, [cursorIndex, cursorStack, i18n.language, t]);

  useEffect(() => {
    fetchHistory(query);
  }, [query, fetchHistory]);

  useEffect(() => {
    setCursorStack([null]);
    setCursorIndex(0);
    setQuery((current) => ({ ...current, search: debouncedSearchDraft }));
  }, [debouncedSearchDraft]);

  const onQueryChange = useCallback((patch) => {
    const { cursor: _ignoredCursor, ...safePatch } = patch || {};
    setCursorStack([null]);
    setCursorIndex(0);
    setQuery((current) => ({ ...current, ...safePatch }));
  }, []);

  const onQueryClear = useCallback(() => {
    setSearchDraft("");
    setCursorStack([null]);
    setCursorIndex(0);
    setQuery((current) => ({ ...current, search: "", status: "", type: "" }));
  }, []);

  const onNext = useCallback(() => {
    if (!pageInfo.hasNextPage || !pageInfo.nextCursor) return;
    setCursorStack((prev) => [...prev.slice(0, cursorIndex + 1), pageInfo.nextCursor]);
    setCursorIndex((prev) => prev + 1);
  }, [cursorIndex, pageInfo]);

  const onPrevious = useCallback(() => {
    if (!pageInfo.hasPreviousPage) return;
    setCursorIndex((prev) => Math.max(0, prev - 1));
  }, [pageInfo.hasPreviousPage]);

  const emptyStateMessage = useMemo(() => t("noHistory") || "No history items found.", [t]);

  return (
    <BlockStack gap="400">
      {error && (
        <Banner tone="critical">
          <p>{error}</p>
        </Banner>
      )}

      <HistoryTable
        histories={histories}
        isLoading={isLoading}
        pageInfo={pageInfo}
        query={query}
        querySearch={searchDraft}
        onSearchChange={setSearchDraft}
        onQueryChange={onQueryChange}
        onQueryClear={onQueryClear}
        onNext={onNext}
        onPrevious={onPrevious}
        emptyStateMessage={emptyStateMessage}
      />

      {toastState.active && (
        <Toast
          content={toastState.message}
          error={toastState.error}
          onDismiss={() => setToastState({ active: false, message: "", error: false })}
        />
      )}
    </BlockStack>
  );
};

export default HistoryComponent;
