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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getTranslatedOperatorLabel } from "../utils/filterUtils";
import ProductsFilters from "../components/ProductsFilters";
import ProductsTable from "../components/ProductsTable";
import useProducts from "../hooks/useProducts";
import { useFilterRegistry } from "../hooks/useFilterRegistry";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import { useSyncStatusHelpers } from "../../../../hooks/useSyncStatusQuery";
import { useApiClient } from "../../../../hooks/useApiClient";

import {
  setProducts,
  setSearch,
  selectFilters,
  selectCursor,
  selectCursorFilterHash,
  selectProductIds,
  applyFilterHashAndResetCursor,
  setCursorForFilterHash,
} from "../../../../store/slices/productSlice";
import { buildCanonicalFilterHash } from "../hooks/useProducts";
import { buildProductTargetingContract } from "../../shared/productTargetingContract";
const MIN_PRODUCT_SEARCH_LENGTH = 2;

function getStableProductId(product) {
  const id =
    product?.shopifyProductId ||
    product?.adminGraphqlApiId ||
    product?.gid ||
    product?.id ||
    product?.__rowId;

  return typeof id === "string" && id.trim() ? id.trim() : "";
}

export default function ProductsPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const api = useApiClient();
  const queryClient = useQueryClient();

  const filterState = useSelector(selectFilters);
  const productIds = useSelector(selectProductIds);
  const cursor = useSelector(selectCursor);
  const cursorFilterHash = useSelector(selectCursorFilterHash);
  const { t } = useTranslation();

  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap-products"],
    queryFn: async ({ signal }) =>
      api.get("/api/bootstrap/products?limit=50", { signal }),
    staleTime: 10_000,
    retry: 1,
  });
  const bootstrapData = bootstrapQuery.data || null;
  const bootstrapSyncStatus = bootstrapData?.syncStatus || null;
  const bootstrapFilterRegistry = bootstrapData?.filterRegistry || null;
  const bootstrapProductList = bootstrapData?.productList || null;
  const bootstrapStoreDetails = bootstrapData?.storeDetails || null;

  const {
    filters: availableFilters,
    getFilterByKey,
    fallbackReason: filterRegistryFallbackReason,
  } = useFilterRegistry({
    initialData: bootstrapFilterRegistry || undefined,
  });
  const isFilterRegistryDegraded =
    filterRegistryFallbackReason === "error" ||
    filterRegistryFallbackReason === "malformed";

  const [committedSearch, setCommittedSearch] = useState("");
  const [searchResetSignal, setSearchResetSignal] = useState(0);

  const {
    syncStatus,
    isSyncInProgress,
    isSyncStale,
  } = useSyncStatusHelpers({
    initialData: bootstrapSyncStatus || undefined,
  });
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

  const effectiveFilterHash = useMemo(
    () => buildCanonicalFilterHash(effectiveFilters),
    [effectiveFilters],
  );

  const bootstrapProductInitialData =
    cursor == null &&
      effectiveFilterHash === "[]" &&
      bootstrapProductList
      ? {
        products: Array.isArray(bootstrapProductList.products)
          ? bootstrapProductList.products
          : [],
        pagination: bootstrapProductList.pagination || null,
        count: Number(bootstrapProductList.count || 0),
        unavailableReason: bootstrapProductList.unavailableReason || null,
        mirrorHealth: bootstrapProductList.mirrorHealth || null,
      }
      : undefined;

  const {
    products,
    totalCount,
    pagination,
    unavailableReason,
    mirrorHealth,
    loading,
    error,
    hasFetched,
    refetch,
    filterHash: productsFilterHash,
  } =
    useProducts({
      cursor,
      filterParams: effectiveFilters,
      cursorFilterHash,
      initialData: bootstrapProductInitialData,
    });

  const productMirrorHealth = mirrorHealth || bootstrapProductList?.mirrorHealth || null;
  const backendProductCount = Number(
    syncStatus?.productCount ??
    bootstrapSyncStatus?.productCount ??
    totalCount ??
    0,
  );
  const filteredProductCount = Number(totalCount || 0);
  const syncNeeded = Boolean(
    syncStatus?.syncNeeded ??
    bootstrapSyncStatus?.syncNeeded ??
    (backendProductCount === 0),
  );
  const emptyMirror = Boolean(
    syncStatus?.emptyMirror ??
    bootstrapSyncStatus?.emptyMirror ??
    (backendProductCount === 0 && syncNeeded),
  );
  const productUnavailableReason =
    unavailableReason ||
    bootstrapProductList?.unavailableReason ||
    bootstrapProductList?.error?.message ||
    null;
  const isProductMirrorUnavailable =
    syncNeeded ||
    Boolean(productUnavailableReason);
  const pageError =
    bootstrapQuery.error?.message ||
    error ||
    null;

  const productIdsCsv = useMemo(
    () =>
      products
        .map(getStableProductId)
        .filter(Boolean)
        .join(","),
    [products],
  );

  const variantsGridQuery = useQuery({
    queryKey: ["variants-grid", productIdsCsv],
    enabled: Boolean(productIdsCsv),
    queryFn: async ({ signal }) => {
      return api.post(
        "/api/variants/query",
        {
          limit: 500,
          productIds: products.map(getStableProductId).filter(Boolean),
        },
        { signal },
      );
    },
    staleTime: 10_000,
    retry: 1,
  });

  useEffect(() => {
    if (!bootstrapStoreDetails) return;
    queryClient.setQueryData(["store-details"], bootstrapStoreDetails);
  }, [bootstrapStoreDetails, queryClient]);

  useEffect(() => {
    const safeProducts = Array.isArray(products) ? products : [];

    const nextSignature = safeProducts
      .map(getStableProductId)
      .filter(Boolean)
      .join("|");

    if (lastProductsSignatureRef.current === nextSignature) {
      return;
    }

    lastProductsSignatureRef.current = nextSignature;
    dispatch(setProducts(safeProducts));
  }, [dispatch, products]);

  const wasSyncingRef = useRef(false);
  const lastProductsSignatureRef = useRef("");

  const applyAtomicFilterCursorReset = useCallback(
    (nextFilters, nextSearch) => {
      const baseFilters = nextFilters.filter((f) => f.field !== "search");
      const normalizedSearch = String(nextSearch || "").trim();
      const nextEffectiveFilters =
        normalizedSearch && normalizedSearch.length >= MIN_PRODUCT_SEARCH_LENGTH
          ? [
            ...baseFilters,
            {
              field: "search",
              operator: "contains",
              value: normalizedSearch,
            },
          ]
          : baseFilters;
      dispatch(
        applyFilterHashAndResetCursor({
          filters: nextFilters,
          filterHash: buildCanonicalFilterHash(nextEffectiveFilters),
        }),
      );
    },
    [dispatch],
  );

  useEffect(() => {
    const isSyncing = isSyncInProgress && !isSyncStale;

    const justCompleted =
      wasSyncingRef.current &&
      !isSyncing &&
      Boolean(syncStatus?.shopifyBulkJobCompleted) &&
      Boolean(syncStatus?.activeMirrorBatchId);

    if (justCompleted) {
      showSuccess(t("productsSyncSuccess"));
      void refetch();
    }

    wasSyncingRef.current = isSyncing;
  }, [
    isSyncInProgress,
    isSyncStale,
    syncStatus?.shopifyBulkJobCompleted,
    syncStatus?.activeMirrorBatchId,
    refetch,
    showSuccess,
    t,
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

    applyAtomicFilterCursorReset(updated, committedSearch);
  }, [filterState, applyAtomicFilterCursorReset, committedSearch]);

  const handleCommitSearch = useCallback(
    (nextSearch) => {
      setCommittedSearch(nextSearch);
      dispatch(setSearch(nextSearch));
      applyAtomicFilterCursorReset(filterState, nextSearch);
    },
    [applyAtomicFilterCursorReset, dispatch, filterState],
  );

  const onClearAll = () => {
    setCommittedSearch("");
    dispatch(setSearch(""));
    setSearchResetSignal((current) => current + 1);
    applyAtomicFilterCursorReset([], "");
  };

  const editTargeting = useMemo(
    () =>
      buildProductTargetingContract({
        filters: filterState,
        searchQuery: committedSearch,
        selectionMode: "filtered",
      }),
    [committedSearch, filterState],
  );

  const handleRemoveFilter = useCallback(
    (field) => {
      const updatedFilters = filterState.filter((f) => f.field !== field);
      applyAtomicFilterCursorReset(updatedFilters, committedSearch);
    },
    [filterState, applyAtomicFilterCursorReset, committedSearch],
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
    bootstrapQuery.isLoading ||
    !hasFetched;

  const shouldShowSyncNeededState =
    !shouldShowLoadingState &&
    !pageError &&
    hasFetched &&
    !isSyncInProgress &&
    syncNeeded &&
    emptyMirror;

  const shouldShowFilteredEmptyState =
    !shouldShowLoadingState &&
    !pageError &&
    hasFetched &&
    !isSyncInProgress &&
    backendProductCount > 0 &&
    products.length === 0;

  const shouldShowProductStatusRail =
    Boolean(pageError) ||
    shouldShowSyncNeededState ||
    (isProductMirrorUnavailable &&
      (!isSyncInProgress || isSyncStale) &&
      backendProductCount === 0) ||
    (isSyncInProgress && !isSyncStale && !products.length) ||
    shouldShowFilteredEmptyState;

  const resultSummary = useMemo(() => {
    if (shouldShowLoadingState) {
      return <SkeletonBodyText lines={1} />;
    }

    if (filteredProductCount > 0) {
      return (
        <InlineStack gap="200" blockAlign="center">
          <Badge tone="info">{filteredProductCount}</Badge>
          <Text variant="bodySm" tone="subdued">
            {t("productsMatch")}
          </Text>
        </InlineStack>
      );
    }

    if (shouldShowFilteredEmptyState) {
      return (
        <Text variant="bodySm" tone="subdued">
          {t("noProductsMatch")}
        </Text>
      );
    }

   if (isSyncInProgress && !isSyncStale) {
      return (
        <Text variant="bodySm" tone="subdued">
          {t("productsSyncingInBackground")}
        </Text>
        // <Text variant="bodySm" tone="subdued">
        //   Products are syncing in the background.
        // </Text>
      );
    }

    return null;
  }, [filteredProductCount, isSyncInProgress, shouldShowFilteredEmptyState, shouldShowLoadingState, t]);

  const handleNextPage = useCallback(() => {
    dispatch(
      setCursorForFilterHash({
        cursor: pagination?.nextCursor || null,
        filterHash: productsFilterHash,
      }),
    );
  }, [dispatch, pagination?.nextCursor, productsFilterHash]);

  const handlePreviousPage = useCallback(() => {
    dispatch(
      setCursorForFilterHash({
        cursor: pagination?.prevCursor || null,
        filterHash: productsFilterHash,
      }),
    );
  }, [dispatch, pagination?.prevCursor, productsFilterHash]);

  return (
    <Page
      title={t("pageTitle")}
      subtitle={t("pageSubtitle")}
      fullWidth
      primaryAction={{
        content: t("edit"),
        onAction: () =>
          navigate("/edit", {
            state: {
              productTargeting: editTargeting,
            },
          }),
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
        {shouldShowProductStatusRail ? (
          <Layout.Section>
            {pageError ? (
              <Banner tone="critical" title="Products could not be loaded">
                <p>{pageError}</p>
              </Banner>
            ) : shouldShowSyncNeededState || (isProductMirrorUnavailable && (!isSyncInProgress || isSyncStale) && backendProductCount === 0) ? (
              <Banner
                tone="warning"
                title={isSyncStale ? "Product sync is stuck" : "Product sync needed"}
              >
                <p>
                  {productUnavailableReason ||
                    "No product mirror is available yet. Start product sync to load product rows."}
                </p>
                <Button variant="plain" onClick={() => navigate("/refresh")}>
                  {t("Syncyourproducts")}
                </Button>
              </Banner>
            ) : isSyncInProgress && !isSyncStale && !products.length ? (
              <Banner tone="info" title="Sync in progress">
                <p>Products are still syncing. Counts and rows will fill in automatically as the mirror updates.</p>
              </Banner>
            ) : shouldShowFilteredEmptyState ? (
              <Banner tone="info" title="No products match the current filters">
                <p>Try changing or clearing filters to broaden the product set.</p>
              </Banner>
            ) : null}
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <Box padding="400">
              {isFilterRegistryDegraded && (
                <Box paddingBlockEnd="300">
                  <Banner
                    tone="warning"
                    title={t("filterRegistryLoadErrorTitle", {
                      defaultValue: "Filter definitions could not be loaded",
                    })}
                  >
                    <p>
                      {t("filterRegistryLoadErrorMessage", {
                        reason: filterRegistryFallbackReason,
                        defaultValue:
                          "Refresh the page before creating or changing filters.",
                      })}
                    </p>
                  </Banner>
                </Box>
              )}
              <ProductsFilters
                appliedFilters={appliedFilters}
                onFilterChange={onFilterChange}
                onCommitSearch={handleCommitSearch}
                searchResetSignal={searchResetSignal}
                onClearAll={onClearAll}
                availableFilters={availableFilters}
              />
            </Box>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            {Boolean(variantsGridQuery.data?.isStale) ? (
              <Box padding="300">
                <Banner tone="warning" title="Mirror data may be outdated">
                  <p>
                    Data may be outdated.{" "}
                    <Button variant="plain" onClick={() => navigate("/refresh")}>
                      Refresh
                    </Button>
                  </p>
                </Banner>
              </Box>
            ) : null}
            <ProductsTable
              productIds={productIds}
              loading={shouldShowLoadingState}
              pagination={pagination}
              onNext={handleNextPage}
              onPrev={handlePreviousPage}
              emptyHeading={
                shouldShowSyncNeededState
                  ? "Sync products to show rows"
                  : shouldShowFilteredEmptyState
                    ? "No products match the current filters"
                  : undefined
              }
              emptyText={
                shouldShowSyncNeededState
                  ? "The product mirror does not have an active batch yet. Run product sync, then this table will fill automatically."
                  : shouldShowFilteredEmptyState
                    ? "Try changing or clearing filters to broaden the product set."
                  : undefined
              }
            />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
