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
  const [fieldSearchDraft, setFieldSearchDraft] = useState("");

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
    setFieldSearchDraft("");
    setIsPopoverOpen(true);
  }, []);

  const handleClosePopover = useCallback(() => {
    setIsPopoverOpen(false);
    setActiveFilterKey(null);
    setFieldSearchDraft("");
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
    setFieldSearchDraft("");
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

  const filteredFieldOptions = useMemo(() => {
    const query = fieldSearchDraft.trim().toLowerCase();
    if (!query) return translatedFilters;

    return translatedFilters.filter((filter) => {
      const haystack = [
        filter.translatedLabel,
        filter.label,
        filter.key,
        ...(Array.isArray(filter.searchAliases) ? filter.searchAliases : []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [fieldSearchDraft, translatedFilters]);

  const actionItems = useMemo(
    () =>
      filteredFieldOptions.map((filter) => ({
        content: filter.translatedLabel,
        onAction: filterActionHandlers[filter.key],
      })),
    [filteredFieldOptions, filterActionHandlers]
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
            <Box width="320px" padding="200">
              <BlockStack gap="200">
                <TextField
                  label={t("filterFieldSearchLabel", "Search filter fields")}
                  labelHidden
                  value={fieldSearchDraft}
                  placeholder={t("filterFieldSearchPlaceholder", "Search filters")}
                  onChange={setFieldSearchDraft}
                  clearButton
                  onClearButtonClick={() => setFieldSearchDraft("")}
                  autoComplete="off"
                />
                {actionItems.length > 0 ? (
                  <ActionList items={actionItems} />
                ) : (
                  <Box padding="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t("noFilterFieldsFound", "No filter fields found")}
                    </Text>
                  </Box>
                )}
              </BlockStack>
            </Box>
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
