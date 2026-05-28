import {
  Page,
  Text,
  Card,
  Button,
  Banner,
  InlineStack,
  Layout,
  Box,
  BlockStack,
  SkeletonBodyText,
  Badge,
} from "@shopify/polaris";
import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
import { useTranslation } from "react-i18next";
import { getTranslatedOperatorLabel } from "../utils/filterUtils";
import ProductsFilters from "../components/ProductsFilters";
import ProductsTable from "../components/ProductsTable";
import useProducts from "../hooks/useProducts";
import { useFilterRegistry } from "../hooks/useFilterRegistry";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import { useSyncStatusHelpers } from "../../../../hooks/useSyncStatusQuery";

import {
  selectFilters,
  setFilters,
  clearFilters,
} from "../../../../store/slices/productSlice";
const MIN_PRODUCT_SEARCH_LENGTH = 2;
const STATUS_RAIL_MIN_HEIGHT = "84px";

export default function ProductsPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const filterState = useSelector(selectFilters);
const { t } = useTranslation();
const {
  filters: availableFilters,
  getFilterByKey,
} = useFilterRegistry();

const [committedSearch, setCommittedSearch] = useState("");
const [searchResetSignal, setSearchResetSignal] = useState(0);
const [cursor, setCursor] = useState(null);

  const {
    syncStatus,
    syncStatusLoading,
    isSyncInProgress,
  } = useSyncStatusHelpers();
  const { showSuccess, showError } = useAppToast();

  const effectiveFilters = useMemo(() => {
    const baseFilters = filterState.filter((f) => f.field !== "search");
    const normalizedSearch = String(committedSearch || "").trim();

    if (
      !normalizedSearch ||
      normalizedSearch.length < MIN_PRODUCT_SEARCH_LENGTH
    ) {
      return baseFilters;
    }

    return [
      ...baseFilters,
      {
        field: "search",
        operator: "contains",
        value: normalizedSearch,
      },
    ];
  }, [filterState, committedSearch]);

  const { products, totalCount, pagination, loading, error, hasFetched, refetch } =
    useProducts({ cursor, filterParams: effectiveFilters });

  const wasSyncingRef = useRef(false);

useEffect(() => {
  setCursor(null);
}, [effectiveFilters]);

  useEffect(() => {
  const isSyncing =
    Boolean(syncStatus?.isProductSyncing) ||
    Boolean(syncStatus?.isProductInitialySyning);

  const justCompleted =
    wasSyncingRef.current &&
    !isSyncing &&
    Boolean(syncStatus?.shopifyBulkJobCompleted) &&
    Boolean(syncStatus?.activeMirrorBatchId);

  if (justCompleted) {
    showSuccess("Products have been synced successfully.");
    void refetch();
  }

  wasSyncingRef.current = isSyncing;
}, [
  syncStatus?.isProductSyncing,
  syncStatus?.isProductInitialySyning,
  syncStatus?.shopifyBulkJobCompleted,
  syncStatus?.activeMirrorBatchId,
  refetch,
  showSuccess,
]);

  useEffect(() => {
    if (!error) return;
    showError(error);
  }, [error, showError]);

  const onFilterChange = useCallback((field, nextFilter) => {
  const updated = (() => {
    const index = filterState.findIndex((f) => f.field === field);
    if (index !== -1) {
      const copy = [...filterState];
      copy[index] = { field, ...nextFilter };
      return copy;
    }
    return [...filterState, { field, ...nextFilter }];
  })();

  dispatch(setFilters(updated));
}, [filterState, dispatch]);

  const onClearAll = () => {
    dispatch(clearFilters());
    setCommittedSearch("");
    setSearchResetSignal((current) => current + 1);
    setCursor(null);
  };

  const handleRemoveFilter = useCallback(
    (field) => {
      dispatch(setFilters(filterState.filter((f) => f.field !== field)));
    },
    [dispatch, filterState],
  );

const appliedFilters = useMemo(
  () =>
    filterState
      .filter((f) => f.field !== "search")
      .map(({ field, operator, value }) => {
        const filter = getFilterByKey(field);

        const translatedFieldLabel = t(
          `fieldLabels.${field}`,
          filter?.label || field
        );

        const translatedOperator = getTranslatedOperatorLabel(t, operator);

        const translatedValue =
          filter?.type === "enum"
            ? t(`filterValueLabels.${value}`, value)
            : value;

        return {
          key: field,
          label: `${translatedFieldLabel} ${translatedOperator} ${translatedValue}`,
          operator,
          value,
          onRemove: () => handleRemoveFilter(field),
        };
      }),
  [filterState, t, getFilterByKey, handleRemoveFilter]
);

  const shouldShowLoadingState =
    loading ||
    !hasFetched ||
    (!products.length && (syncStatusLoading || isSyncInProgress));

  const shouldShowEmptyState =
    !shouldShowLoadingState &&
    !error &&
    hasFetched &&
    !isSyncInProgress &&
    totalCount === 0;

  const resultSummary = useMemo(() => {
    if (shouldShowLoadingState) {
      return <SkeletonBodyText lines={1} />;
    }

    if (totalCount > 0) {
      return (
        <InlineStack gap="200" blockAlign="center">
          <Badge tone="info">{totalCount}</Badge>
          <Text variant="bodySm" tone="subdued">
            {t("productsMatch")}
          </Text>
        </InlineStack>
      );
    }

    if (shouldShowEmptyState) {
      return (
        <Text variant="bodySm" tone="subdued">
          {t("noProductsMatch")}
        </Text>
      );
    }

    if (isSyncInProgress) {
      return (
        <Text variant="bodySm" tone="subdued">
          Products are syncing in the background.
        </Text>
      );
    }

    return null;
  }, [isSyncInProgress, shouldShowEmptyState, shouldShowLoadingState, totalCount]);

  return (
    <Page
      title={t("pageTitle")}
      subtitle={t("pageSubtitle")}
      fullWidth
      primaryAction={{
        content: t("edit"),
        onAction: () => navigate("/edit"),
      }}
      secondaryActions={[
        {
          content: t("export"),
          onAction: () => navigate("/exportdata"),
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <Box padding="500">
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    {t("productTargeting")}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t("productTargetingDescription")}
                  </Text>
                </BlockStack>
                <InlineStack gap="200" blockAlign="center">
                  {resultSummary}
                  <Button variant="plain" onClick={() => navigate("/refresh")}>
                    {t("Syncyourproducts")}
                  </Button>
                </InlineStack>
              </InlineStack>
            </Box>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <Box minHeight={STATUS_RAIL_MIN_HEIGHT}>
            {isSyncInProgress && !products.length ? (
              <Banner tone="info" title="Sync in progress">
                <p>Products are still syncing. Counts and rows will fill in automatically as the mirror updates.</p>
              </Banner>
            ) : null}
          </Box>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Box padding="400">
              <ProductsFilters
                appliedFilters={appliedFilters}
                onFilterChange={onFilterChange}
                onCommitSearch={setCommittedSearch}
                searchResetSignal={searchResetSignal}
                onClearAll={onClearAll}
                availableFilters={availableFilters}
              />
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <ProductsTable
              products={products}
              loading={shouldShowLoadingState}
              pagination={pagination}
              onNext={() => setCursor(pagination?.nextCursor || null)}
              onPrev={() => setCursor(pagination?.prevCursor || null)}
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
