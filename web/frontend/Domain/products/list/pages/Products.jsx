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
  const isProductMirrorUnavailable =
    Boolean(productUnavailableReason) ||
    (!productMirrorHealth?.activeMirrorBatchId && totalCount === 0);

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
    !hasFetched;

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
  }, [isSyncInProgress, shouldShowEmptyState, shouldShowLoadingState, totalCount, t]);

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
            {isProductMirrorUnavailable && (!isSyncInProgress || isSyncStale) ? (
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
            ) : null}
          </Box>
        </Layout.Section>

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
              productIds={productIds}
              loading={shouldShowLoadingState}
              pagination={pagination}
              onNext={() =>
                dispatch(
                  setCursorForFilterHash({
                    cursor: pagination?.nextCursor || null,
                    filterHash,
                  }),
                )
              }
              onPrev={() =>
                dispatch(
                  setCursorForFilterHash({
                    cursor: pagination?.prevCursor || null,
                    filterHash,
                  }),
                )
              }
              emptyHeading={
                isProductMirrorUnavailable
                  ? "Sync products to show rows"
                  : undefined
              }
              emptyText={
                isProductMirrorUnavailable
                  ? "The product mirror does not have an active batch yet. Run product sync, then this table will fill automatically."
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
