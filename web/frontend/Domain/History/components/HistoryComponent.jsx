import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Banner, BlockStack } from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import HistoryTable from "../components/HistoryTable";
import { toSafeErrorMessage } from "../../../utils/frontendError";
import useDebouncedValue from "../../../hooks/useDebouncedValue";
import { useHistoryListQuery } from "../hooks/useHistoryListQuery";

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
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [cursorStack, setCursorStack] = useState([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [searchDraft, setSearchDraft] = useState(DEFAULT_QUERY.search);
  const debouncedSearchDraft = useDebouncedValue(searchDraft, 400);
  const activeCursor = cursorStack[cursorIndex] || null;
  const historyQuery = useHistoryListQuery({
    query,
    cursor: activeCursor,
    lang: i18n.language || "en",
  });

  const histories = historyQuery.data?.items || historyQuery.data?.data || [];
  const info = historyQuery.data?.pageInfo || historyQuery.data?.meta?.pageInfo || {};
  const pageInfo = useMemo(
    () => ({
      hasNextPage: Boolean(info.hasNextPage),
      hasPreviousPage: cursorIndex > 0,
      nextCursor: info.nextCursor || info.endCursor || null,
    }),
    [cursorIndex, info.endCursor, info.hasNextPage, info.nextCursor],
  );

  const error = historyQuery.error
    ? toSafeErrorMessage(t, historyQuery.error, "common.errors.generic")
    : null;

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
        isLoading={historyQuery.isLoading}
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
    </BlockStack>
  );
};

export default HistoryComponent;
