import React, { memo, useMemo, useState, useCallback, useEffect } from "react";
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

const FILTER_UI_OVERRIDES = {
  vendor: {
    api: "/api/products/filter-values/vendor",
  },
  productType: {
    api: "/api/products/filter-values/productType",
  },
  title: {
    api: "/api/products/filter-values/title",
  },
  handle: {
    api: "/api/products/filter-values/handle",
  },
  status: {
    type: "enum",
    isSearchable: false,
    values: ["ACTIVE", "DRAFT", "ARCHIVED"],
  },
  tags: {
    api: "/api/products/filter-values/tags",
  },
  collections: {
    api: "/api/products/filter-values/collections",
  },
  categoryName: {
    api: "/api/products/filter-values/categoryName",
  },
};

const ProductsFilters = memo(function ProductsFilters({
  appliedFilters,
  appliedSearch = "",
  onFilterChange,
  onCommitSearch,
  searchLoading = false,
  searchResetSignal = 0,
  onClearAll,
  availableFilters = [],
}) {
  const { t, i18n } = useTranslation();

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [activeFilterKey, setActiveFilterKey] = useState(null);
  const [searchDraft, setSearchDraft] = useState("");
  const normalizedAppliedSearch = String(appliedSearch || "").trim();

  useEffect(() => {
    setSearchDraft("");
  }, [searchResetSignal]);

  const handleSearchSubmit = useCallback(() => {
    onCommitSearch?.(searchDraft.trim());
  }, [onCommitSearch, searchDraft]);

  const handleSearchDraftChange = useCallback(
    (nextValue) => {
      setSearchDraft(nextValue);
      if (String(nextValue || "").trim() === "" && normalizedAppliedSearch) {
        onCommitSearch?.("");
      }
    },
    [normalizedAppliedSearch, onCommitSearch],
  );

  const handleSearchClear = useCallback(() => {
    setSearchDraft("");
    if (normalizedAppliedSearch) {
      onCommitSearch?.("");
    }
  }, [normalizedAppliedSearch, onCommitSearch]);

  const handleSearchKeyDown = useCallback(
    (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      handleSearchSubmit();
    },
    [handleSearchSubmit],
  );

  const translatedText = useMemo(
    () => ({
      filtersHeading: t("filters"),
      filtersDescription: t("filtersDescription"),
      searchPlaceholder: t("searchPlaceholder"),
      addFilter: t("addFilter"),
      clearAll: t("clearFilters", "Clear Filters"),
      searchButton: t("searchButton", "Search"),
      cancel: t("cancel", "Cancel"),
    }),
    [t, i18n.language]
  );

  const translatedFilters = useMemo(
    () =>
      availableFilters.map((filter) => {
        const override = FILTER_UI_OVERRIDES[filter.key] || {};

        return {
          ...filter,
          ...override,
          values: override.values || filter.values || [],
          translatedLabel: t(`fieldLabels.${filter.key}`, filter.label),
        };
      }),
    [availableFilters, t, i18n.language]
  );

  const activeFilter = useMemo(
    () =>
      translatedFilters.find((filter) => filter.key === activeFilterKey) || null,
    [translatedFilters, activeFilterKey]
  );

  const appliedFilterMap = useMemo(() => {
    return appliedFilters.reduce((acc, item) => {
      acc[item.key] = item;
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
        onAction: () => handleSelectFilter(filter.key),
      })),
    [translatedFilters, handleSelectFilter]
  );

  return (
    <BlockStack gap="300">
      <InlineHeader
        heading={translatedText.filtersHeading}
        description={translatedText.filtersDescription}
      />

      <BlockStack gap="300">
        <InlineStack align="space-between" gap="400" wrap blockAlign="center">
          <Box minWidth="320px" width="520px">
            <TextField
              labelHidden
              value={searchDraft}
              placeholder={translatedText.searchPlaceholder}
              onChange={handleSearchDraftChange}
              onKeyDown={handleSearchKeyDown}
              clearButton
              onClearButtonClick={handleSearchClear}
              autoComplete="off"
            />
          </Box>

          <Button
            variant="primary"
            onClick={handleSearchSubmit}
            loading={searchLoading}
            disabled={searchLoading}
          >
            {translatedText.searchButton}
          </Button>
        </InlineStack>

        <InlineStack gap="200" wrap blockAlign="center">
          <Popover
            active={isPopoverOpen}
            activator={
              <Button onClick={handleOpenPicker}>
                {translatedText.addFilter}
              </Button>
            }
            autofocusTarget="first-node"
            onClose={handleClosePopover}
            preferredAlignment="left"
          >
            {!activeFilter ? (
              <ActionList items={actionItems} />
            ) : (
              <FilterPanel
                filter={activeFilter}
                initialFilter={appliedFilterMap[activeFilter.key]}
                onApply={handleApplyFilter}
                onCancel={handleBackToList}
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
      </BlockStack>

      {appliedFilters.length > 0 && (
        <InlineStack gap="200" wrap>
          {appliedFilters.map((item) => (
            <Tag key={item.key} onRemove={item.onRemove}>
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
      <Text as="p" variant="bodySm" tone="subdued">
        {description}
      </Text>
    </BlockStack>
  );
});

export default ProductsFilters;
