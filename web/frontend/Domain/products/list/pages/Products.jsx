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
import TableErrorBoundary from "../../../../components/Error/TableErrorBoundary";
import VariantMetafieldGrid from "../../../variantMetafields/VariantMetafieldGrid";

import {
  setProducts,
  selectFilters,
  selectCursor,
  selectFilterHash,
  selectCursorFilterHash,
  selectProductIds,
  applyFilterHashAndResetCursor,
  setCursorForFilterHash,
} from "../../../../store/slices/productSlice";
import { buildCanonicalFilterHash } from "../hooks/useProducts";
const MIN_PRODUCT_SEARCH_LENGTH = 2;
const STATUS_RAIL_MIN_HEIGHT = "84px";

function formatProductTargetingStatus({ isSyncInProgress, isSyncStale }) {
  if (isSyncInProgress && !isSyncStale) {
    return "Syncing in background";
  }
  return null;
}

export default function ProductsPage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const api = useApiClient();
  const queryClient = useQueryClient();

  const filterState = useSelector(selectFilters);
  const productIds = useSelector(selectProductIds);
  const cursor = useSelector(selectCursor);
  const filterHash = useSelector(selectFilterHash);
  const cursorFilterHash = useSelector(selectCursorFilterHash);
  const { t } = useTranslation();

  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap-products"],
    queryFn: async ({ signal }) =>
      api.get("/api/bootstrap/products?limit=20", { signal }),
    staleTime: 10_000,
    refetchOnMount: "always",
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
  } = useFilterRegistry({
    initialData: bootstrapFilterRegistry || undefined,
  });

  const [committedSearch, setCommittedSearch] = useState("");
  const [searchResetSignal, setSearchResetSignal] = useState(0);
  const [paginationDirection, setPaginationDirection] = useState(null);

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

  const bootstrapProductInitialData =
    cursor == null &&
      String(filterHash || "[]") === "[]" &&
      bootstrapProductList
      ? {
        products: Array.isArray(bootstrapProductList.products)
          ? bootstrapProductList.products
          : [],
        pagination: bootstrapProductList.pagination || null,
        count: Number(bootstrapProductList.count || 0),
      }
      : undefined;

  const {
    products,
    totalCount,
    pagination,
    unavailableReason,
    mirrorHealth,
    loading,
    fetching,
    placeholderData,
    hasProductData,
    error,
    hasFetched,
    refetch,
  } =
    useProducts({
      cursor,
      filterParams: effectiveFilters,
      filterHash,
      cursorFilterHash,
      initialData: bootstrapProductInitialData,
    });

  const productMirrorHealth = mirrorHealth || bootstrapProductList?.mirrorHealth || null;
  const productUnavailableReason =
    unavailableReason ||
    bootstrapProductList?.unavailableReason ||
    bootstrapProductList?.error?.message ||
    null;
  const backendProductCount = Number(
    syncStatus?.productCount ??
    syncStatus?.activeProductRowCount ??
    bootstrapSyncStatus?.productCount ??
    bootstrapSyncStatus?.activeProductRowCount ??
    0,
  );
  const hasRowsAvailable = products.length > 0 || totalCount > 0 || backendProductCount > 0;
  const syncCanPreviewProducts =
    syncStatus?.canPreviewProducts === true ||
    syncStatus?.mirrorReady === true;
  const hasActiveMirrorBatch = Boolean(
    productMirrorHealth?.activeMirrorBatchId || syncStatus?.activeMirrorBatchId,
  );
  const mirrorReady = syncCanPreviewProducts || (hasActiveMirrorBatch && hasRowsAvailable);
  const activeSyncInProgress = isSyncInProgress && !isSyncStale;
  const syncExplicitlyBlocksPreview =
    Boolean(syncStatus) &&
    syncStatus?.canPreviewProducts === false &&
    syncStatus?.mirrorReady !== true &&
    !isSyncInProgress &&
    !isSyncStale;
  const isProductMirrorUnavailable =
    !hasRowsAvailable &&
    !mirrorReady &&
    (
      Boolean(productUnavailableReason) ||
      !hasActiveMirrorBatch ||
      syncExplicitlyBlocksPreview
    );
  // A background refresh must never hide the last valid mirror. Only block the
  // table when there are genuinely no rows to show yet.
  const shouldShowSyncWaitingState = activeSyncInProgress && !hasRowsAvailable;
  const shouldShowStatusRail =
    isProductMirrorUnavailable ||
    shouldShowSyncWaitingState;

  const productIdsCsv = useMemo(
    () =>
      products
        .map((product) => String(product?.id || "").trim())
        .filter(Boolean)
        .join(","),
    [products],
  );

  const metafieldDefinitionsQuery = useQuery({
    queryKey: ["metafield-definitions"],
    queryFn: async ({ signal }) =>
      api.get("/api/metafield-definitions", { signal }),
    staleTime: 30_000,
    retry: 1,
  });

  const variantsGridQuery = useQuery({
    queryKey: ["variants-grid", productIdsCsv],
    enabled: Boolean(productIdsCsv),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      params.set("limit", "500");
      params.set("productIds", productIdsCsv);
      return api.get(`/api/variants?${params.toString()}`, { signal });
    },
    staleTime: 10_000,
    retry: 1,
  });

  const [sessionId, setSessionId] = useState(null);
  const sessionSeedRef = useRef("");

  const variantRows = useMemo(
    () =>
      Array.isArray(variantsGridQuery.data?.rows)
        ? variantsGridQuery.data.rows
        : [],
    [variantsGridQuery.data?.rows],
  );

  const variantCount = variantRows.length;

  useEffect(() => {
    const nextSeed = `${productIdsCsv}:${variantCount}`;

    if (!productIdsCsv || variantCount === 0) {
      if (sessionSeedRef.current !== "") {
        sessionSeedRef.current = "";
        setSessionId(null);
      }

      return;
    }

    if (sessionSeedRef.current === nextSeed) {
      return;
    }

    let active = true;
    sessionSeedRef.current = nextSeed;

    async function createSession() {
      try {
        const created = await api.post("/api/sessions", {
          filterParams: effectiveFilters,
          variantCount,
        });

        const nextSessionId = String(created?.session?.id || "").trim();

        if (!active) return;

        setSessionId(nextSessionId || null);
      } catch {
        if (!active) return;
        setSessionId(null);
      }
    }

    void createSession();

    return () => {
      active = false;
    };
  }, [api, productIdsCsv, variantCount, effectiveFilters]);

  useEffect(() => {
    if (!bootstrapStoreDetails) return;
    queryClient.setQueryData(["store-details"], bootstrapStoreDetails);
  }, [bootstrapStoreDetails, queryClient]);

  useEffect(() => {
    if (!fetching) {
      setPaginationDirection(null);
    }
  }, [fetching]);

  useEffect(() => {
    const safeProducts = Array.isArray(products) ? products : [];

    const nextSignature = safeProducts
      .map((product) => String(product?.id || ""))
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
      void queryClient.cancelQueries({ queryKey: ["products"] });
      dispatch(
        applyFilterHashAndResetCursor({
          filters: nextFilters,
          filterHash: buildCanonicalFilterHash(nextEffectiveFilters),
        }),
      );
    },
    [dispatch, queryClient],
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
      void queryClient.invalidateQueries({ queryKey: ["sync-status"] });
      void queryClient.invalidateQueries({ queryKey: ["product-sync-status"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap-products"] });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["variants-grid"] });
      void refetch();
    }

    wasSyncingRef.current = isSyncing;
  }, [
    isSyncInProgress,
    isSyncStale,
    syncStatus?.shopifyBulkJobCompleted,
    syncStatus?.activeMirrorBatchId,
    queryClient,
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
      applyAtomicFilterCursorReset(filterState, nextSearch);
    },
    [applyAtomicFilterCursorReset, filterState],
  );

  const onClearAll = () => {
    setCommittedSearch("");
    setSearchResetSignal((current) => current + 1);
    applyAtomicFilterCursorReset([], "");
  };

  const handleRemoveFilter = useCallback(
    (field) => {
      const updatedFilters = filterState.filter((f) => f.field !== field);
      applyAtomicFilterCursorReset(updatedFilters, committedSearch);
    },
    [filterState, applyAtomicFilterCursorReset, committedSearch],
  );

  const handleNextPage = useCallback(() => {
    if (!pagination?.hasNextPage || fetching) return;
    setPaginationDirection("next");
    dispatch(
      setCursorForFilterHash({
        cursor: pagination?.nextCursor || null,
        filterHash,
      }),
    );
  }, [dispatch, fetching, filterHash, pagination?.hasNextPage, pagination?.nextCursor]);

  const handlePreviousPage = useCallback(() => {
    if (!pagination?.hasPrevPage || fetching) return;
    setPaginationDirection("previous");
    dispatch(
      setCursorForFilterHash({
        cursor: pagination?.prevCursor || null,
        filterHash,
      }),
    );
  }, [dispatch, fetching, filterHash, pagination?.hasPrevPage, pagination?.prevCursor]);

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
    (loading || !hasFetched) &&
    !hasProductData;
  const isPaginating = fetching && placeholderData && hasProductData;

  const shouldShowEmptyState =
    !shouldShowLoadingState &&
    !error &&
    hasFetched &&
    !shouldShowSyncWaitingState &&
    totalCount === 0;
  const tableProductIds = useMemo(() => {
    if (productIds.length > 0) return productIds;
    return products
      .map((product) => String(product?.__rowId || product?.id || "").trim())
      .filter(Boolean);
  }, [productIds, products]);

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

   if (activeSyncInProgress) {
      const statusLabel = formatProductTargetingStatus({
        isSyncInProgress,
        isSyncStale,
      });
      return (
        <Text variant="bodySm" tone="subdued">
          {t("productsSyncingInBackground", statusLabel)}
        </Text>
      );
    }

    return null;
  }, [activeSyncInProgress, isSyncInProgress, isSyncStale, shouldShowEmptyState, shouldShowLoadingState, totalCount, t]);

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
        {shouldShowStatusRail ? (
          <Layout.Section>
            <Box minHeight={STATUS_RAIL_MIN_HEIGHT}>
              {isProductMirrorUnavailable ? (
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
              ) : (
                <Banner tone="info" title="Sync in progress">
                  <p>Products are still syncing. Counts and rows will fill in automatically as the mirror updates.</p>
                </Banner>
              )}
            </Box>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card>
            <Box padding="400">
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
              productIds={tableProductIds}
              loading={shouldShowLoadingState}
              fetching={isPaginating}
              fetchingDirection={isPaginating ? paginationDirection : null}
              pagination={pagination}
              onNext={handleNextPage}
              onPrev={handlePreviousPage}
              emptyHeading={
                isProductMirrorUnavailable
                  ? "Sync products to show rows"
                  : shouldShowSyncWaitingState
                    ? "Sync in progress"
                  : undefined
              }
              emptyText={
                isProductMirrorUnavailable
                  ? "The product mirror does not have an active batch yet. Run product sync, then this table will fill automatically."
                  : shouldShowSyncWaitingState
                    ? "Products are still syncing. Counts and rows will fill in automatically as the mirror updates."
                  : undefined
              }
            />
            {sessionId ? (
              <Box padding="400" borderBlockStartWidth="1" borderColor="border">
                <TableErrorBoundary>
                  <VariantMetafieldGrid
                    sessionId={sessionId}
                    variants={variantRows}
                    definitions={
                      Array.isArray(metafieldDefinitionsQuery.data?.definitions)
                        ? metafieldDefinitionsQuery.data.definitions
                        : []
                    }
                  />
                </TableErrorBoundary>
              </Box>
            ) : null}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
