import React, { memo, useMemo, useState, useCallback, useEffect, useRef } from "react";
import {
  BlockStack,
  Text,
  InlineStack,
  Button,
  Popover,
  ActionList,
  Box,
  TextField,
  Tag,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import FilterPanel from "./FilterPanel";

const ProductsFilters = memo(function ProductsFilters({
  appliedFilters,
  onFilterChange,
  onCommitSearch,
  searchResetSignal = 0,
  onClearAll,
  availableFilters = [],
}) {
  const { t } = useTranslation();

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [activeFilterKey, setActiveFilterKey] = useState(null);
  const [searchDraft, setSearchDraft] = useState("");

  const onCommitSearchRef = useRef(onCommitSearch);
  const hasMountedRef = useRef(false);
  const previousSearchResetSignalRef = useRef(searchResetSignal);
  const lastCommittedSearchRef = useRef("");
  useEffect(() => {
    onCommitSearchRef.current = onCommitSearch;
  }, [onCommitSearch]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      lastCommittedSearchRef.current = searchDraft;
      return;
    }

    if (lastCommittedSearchRef.current === searchDraft) {
      return;
    }

    const timer = window.setTimeout(() => {
      lastCommittedSearchRef.current = searchDraft;
      onCommitSearchRef.current?.(searchDraft);
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchDraft]);

  useEffect(() => {
    if (previousSearchResetSignalRef.current === searchResetSignal) {
      return;
    }

    previousSearchResetSignalRef.current = searchResetSignal;
    setSearchDraft("");
    lastCommittedSearchRef.current = "";
    onCommitSearchRef.current?.("");
  }, [searchResetSignal]);

  const translatedText = useMemo(
    () => ({
      filtersHeading: t("filters", "Filters"),
      filtersDescription: t("filtersDescription", ""),
      searchPlaceholder: t("searchPlaceholder", "Search products"),
      searchLabel: t("searchLabel", "Search products"),
      addFilter: t("addFilter", "Add filter"),
      clearAll: t("clearFilters", "Clear Filters"),
      back: t("back", "Back"),
    }),
    [t]
  );

  const translatedFilters = useMemo(
    () =>
      availableFilters.map((filter) => ({
        ...filter,
        translatedLabel: t(`fieldLabels.${filter.key}`, filter.label),
      })),
    [availableFilters, t]
  );

  const activeFilter = useMemo(
    () =>
      translatedFilters.find((filter) => filter.key === activeFilterKey) || null,
    [translatedFilters, activeFilterKey]
  );

  const appliedFilterMap = useMemo(() => {
    return appliedFilters.reduce((acc, item) => {
      const key = item.key ?? item.field;
      if (key) acc[key] = item;
      return acc;
    }, {});
  }, [appliedFilters]);

  const handleOpenPicker = useCallback(() => {
    setActiveFilterKey(null);
    setIsPopoverOpen(true);
  }, []);

  const handleClosePopover = useCallback(() => {
    setIsPopoverOpen(false);
    setActiveFilterKey(null);
  }, []);

  const handleSelectFilter = useCallback((filterKey) => {
    setActiveFilterKey(filterKey);
  }, []);

  const filterActionHandlers = useMemo(
    () =>
      Object.fromEntries(
        translatedFilters.map((filter) => [
          filter.key,
          () => handleSelectFilter(filter.key),
        ])
      ),
    [translatedFilters, handleSelectFilter]
  );

  const handleClearSearch = useCallback(() => {
    setSearchDraft("");
  }, []);

  const handleBackToList = useCallback(() => {
    setActiveFilterKey(null);
  }, []);

  const handleApplyFilter = useCallback(
    (nextFilter) => {
      onFilterChange(nextFilter.field, {
        operator: nextFilter.operator,
        value: nextFilter.value,
      });
      handleClosePopover();
    },
    [onFilterChange, handleClosePopover]
  );

  const actionItems = useMemo(
    () =>
      translatedFilters.map((filter) => ({
        content: filter.translatedLabel,
        onAction: filterActionHandlers[filter.key],
      })),
    [translatedFilters, filterActionHandlers]
  );

  return (
    <BlockStack gap="300">
      <InlineHeader
        heading={translatedText.filtersHeading}
        description={translatedText.filtersDescription}
      />

      <InlineStack gap="200" wrap blockAlign="center">
        <Box minWidth="320px">
          <TextField
            label={translatedText.searchLabel}
            labelHidden
            value={searchDraft}
            placeholder={translatedText.searchPlaceholder}
            onChange={setSearchDraft}
            clearButton
            onClearButtonClick={handleClearSearch}
            autoComplete="off"
          />
        </Box>

        <Popover
          active={isPopoverOpen}
          activator={
            <Button onClick={handleOpenPicker}>
              {translatedText.addFilter}
            </Button>
          }
          autofocusTarget="first-node"
          onClose={handleClosePopover}
        >
          {!activeFilter ? (
            <ActionList items={actionItems} />
          ) : (
            <FilterPanel
              filter={activeFilter}
              initialFilter={appliedFilterMap[activeFilter.key]}
              onApply={handleApplyFilter}
              onCancel={handleBackToList}
              cancelLabel={translatedText.back}
              t={t}
            />
          )}
        </Popover>

        {appliedFilters.length > 0 && (
          <Button variant="plain" onClick={onClearAll}>
            {translatedText.clearAll}
          </Button>
        )}
      </InlineStack>

      {appliedFilters.length > 0 && (
        <InlineStack gap="200" wrap>
          {appliedFilters.map((item, index) => (
            <Tag
              key={item.key ?? item.field ?? index}
              onRemove={typeof item.onRemove === "function" ? item.onRemove : undefined}
            >
              {item.label}
            </Tag>
          ))}
        </InlineStack>
      )}
    </BlockStack>
  );
});

const InlineHeader = memo(function InlineHeader({ heading, description }) {
  return (
    <BlockStack gap="100">
      <Text as="h3" variant="headingSm">
        {heading}
      </Text>
      {description && (
        <Text as="p" variant="bodySm" tone="subdued">
          {description}
        </Text>
      )}
    </BlockStack>
  );
});

export default ProductsFilters;
