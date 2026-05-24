import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Banner, Toast, BlockStack } from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import HistoryTable from "../components/HistoryTable";
import { historyService } from "../services/historyService";

const DEFAULT_QUERY = {
  cursor: null,
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
  const [histories, setHistories] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
  });

  const fetchHistory = useCallback(async (nextQuery) => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await historyService.getHistories(
        { ...nextQuery, lang: i18n.language || "en" },
        undefined,
      );
      const items = response.items || response.data || [];
      const info = response.pageInfo || response.meta?.pageInfo || {};
      setHistories(items);
      setPageInfo({
        hasNextPage: Boolean(info.hasNextPage),
        hasPreviousPage: Boolean(info.hasPreviousPage),
        nextCursor: info.nextCursor || info.endCursor || null,
        previousCursor: info.previousCursor || null,
      });
    } catch (err) {
      setError(err?.message || "Failed to fetch histories");
    } finally {
      setIsLoading(false);
    }
  }, [i18n.language]);

  useEffect(() => {
    fetchHistory(query);
  }, [query, fetchHistory]);

  const onQueryChange = useCallback((patch) => {
    setQuery((current) => ({ ...current, ...patch }));
  }, []);

  const onQueryClear = useCallback(() => {
    setQuery((current) => ({ ...current, search: "", status: "", type: "", cursor: null }));
  }, []);

  const onNext = useCallback(() => {
    if (!pageInfo.hasNextPage || !pageInfo.nextCursor) return;
    setQuery((current) => ({ ...current, cursor: pageInfo.nextCursor }));
  }, [pageInfo]);

  const onPrevious = useCallback(() => {
    if (!pageInfo.hasPreviousPage || !pageInfo.previousCursor) return;
    setQuery((current) => ({ ...current, cursor: pageInfo.previousCursor }));
  }, [pageInfo]);

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
