import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Card,
  Thumbnail,
  Text,
  Badge,
  InlineStack,
  BlockStack,
  Pagination,
  Box,
  SkeletonBodyText,
  EmptyState,
  IndexTable,
  Button,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { usePreviewVariantDetailsQuery } from "../hooks/usePreviewVariantDetailsQuery";

const FALLBACK_PRODUCT_IMAGE = "/assets/product-placeholder.svg";
const EMPTY_STATE_IMAGE = "/assets/empty-preview.svg";

const MAX_DISPLAY_VALUE_LENGTH = 160;
const MAX_EXPANDED_VARIANTS = 50;
const VARIANT_DETAILS_PAGE_LIMIT = 50;

function safeString(value, fallback = "-") {
  if (value === undefined || value === null) return fallback;
  const stringValue = String(value).trim();
  if (!stringValue) return fallback;
  return stringValue.length > MAX_DISPLAY_VALUE_LENGTH
    ? `${stringValue.slice(0, MAX_DISPLAY_VALUE_LENGTH)}...`
    : stringValue;
}

function safeRawString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  const stringValue = String(value).trim();
  return stringValue || fallback;
}

function formatValue(value) {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") {
    const preferredValue =
      value.displayText ?? value.text ?? value.label ?? value.value;
    if (preferredValue !== undefined && preferredValue !== null) {
      return safeString(preferredValue);
    }
    return "[complex value]";
  }
  return safeString(value);
}

function safePositiveInteger(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 1) return fallback;
  return Math.floor(numberValue);
}

function safeNonNegativeInteger(value, fallback = 0) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return fallback;
  return Math.floor(numberValue);
}

function buildPreviewRowKey(product, index) {
  const snapshotItemId = safeRawString(product?.snapshotItemId, null);
  const productId = safeRawString(product?.productId || product?.id, null);
  const variantId = safeRawString(product?.variantId, null);
  const handle = safeRawString(product?.handle, null);

  if (snapshotItemId) return `snapshot:${snapshotItemId}`;
  if (productId && variantId) return `product:${productId}:variant:${variantId}`;
  if (productId) return `product:${productId}`;
  if (handle) return `handle:${handle}`;
  return `preview:${index}`;
}

const VariantDetailsPanel = memo(function VariantDetailsPanel({ variants, t }) {
  const safeVariants = Array.isArray(variants) ? variants : [];
  if (!safeVariants.length) {
    return (
      <Text as="p" tone="subdued" variant="bodySm">
        -
      </Text>
    );
  }

  const visibleVariants = safeVariants.slice(0, MAX_EXPANDED_VARIANTS);
  const hiddenCount = safeVariants.length - visibleVariants.length;

  return (
    <BlockStack gap="200">
      {visibleVariants.map((variant, index) => {
        const key = String(
          variant?.snapshotItemId || variant?.id || variant?.variantId || `variant-${index}`,
        );

        return (
          <InlineStack key={key} gap="200" align="start" wrap>
            <Badge tone="info">
              {formatValue(variant?.title || `Variant ${index + 1}`)}
            </Badge>

            <Text as="span" tone="subdued" textDecorationLine="line-through">
              {formatValue(variant?.oldValue)}
            </Text>

            <Text as="span" variant="bodyMd" fontWeight="semibold" tone="success">
              {formatValue(variant?.newValue)}
            </Text>
          </InlineStack>
        );
      })}

      {hiddenCount > 0 ? (
        <Text as="p" variant="bodySm" tone="subdued">
          {t("products:additionalVariantsHidden", {
            defaultValue:
              "{{count}} more variants hidden. Narrow the preview or open product details.",
            count: hiddenCount,
          })}
        </Text>
      ) : null}
    </BlockStack>
  );
});

const VariantDetailsSection = memo(function VariantDetailsSection({
  previewId,
  productId,
  rowKey,
  t,
}) {
  const [detailsPage, setDetailsPage] = useState(1);

  const variantDetailsQuery = usePreviewVariantDetailsQuery({
    previewId,
    productId,
    page: detailsPage,
    limit: VARIANT_DETAILS_PAGE_LIMIT,
    enabled: Boolean(previewId && productId),
  });

  const details = variantDetailsQuery.data || null;
  const rows = details?.rows || [];
  const page = safePositiveInteger(details?.page, detailsPage);
  const totalPages = safePositiveInteger(details?.totalPages, 1);
  const total = safeNonNegativeInteger(details?.total, rows.length);
  const fromItem = total === 0 ? 0 : Math.min((page - 1) * VARIANT_DETAILS_PAGE_LIMIT + 1, total);
  const toItem = total === 0 ? 0 : Math.min(page * VARIANT_DETAILS_PAGE_LIMIT, total);

  useEffect(() => {
    setDetailsPage(1);
  }, [previewId, productId, rowKey]);

  if (variantDetailsQuery.isLoading || variantDetailsQuery.isFetching) {
    return <SkeletonBodyText lines={3} />;
  }

  if (variantDetailsQuery.isError) {
    return (
      <Text as="p" tone="critical" variant="bodySm">
        {t("common.errors.generic", {
          defaultValue: "Unable to load variant details.",
        })}
      </Text>
    );
  }

  return (
    <BlockStack gap="200">
      <VariantDetailsPanel variants={rows} t={t} />

      <InlineStack align="space-between" blockAlign="center" gap="200">
        <Text as="p" variant="bodySm" tone="subdued">
          {t("products:showingVariantsRange", {
            defaultValue: "Showing {{from}} to {{to}} of {{total}} variants",
            from: fromItem,
            to: toItem,
            total,
          })}
        </Text>

        <Pagination
          hasPrevious={page > 1}
          onPrevious={() => setDetailsPage((current) => Math.max(1, current - 1))}
          hasNext={page < totalPages}
          onNext={() => setDetailsPage((current) => current + 1)}
        />
      </InlineStack>
    </BlockStack>
  );
});

function PreviewTable({
  loading = false,
  products = [],
  pagination = {},
  onPageChange,
  isVariant = false,
}) {
  const { t } = useTranslation(["products", "common"]);
  const [expandedRows, setExpandedRows] = useState(() => new Set());

  const safeProducts = useMemo(() => (Array.isArray(products) ? products : []), [products]);
  const page = safePositiveInteger(pagination?.page, 1);
  const limit = safePositiveInteger(pagination?.limit, safeProducts.length || 25);
  const total = safeNonNegativeInteger(pagination?.total, safeProducts.length);
  const totalPages = safePositiveInteger(
    pagination?.totalPages,
    Math.max(1, Math.ceil(total / limit)),
  );
  const resultVersion =
    pagination?.resultVersion ||
    pagination?.previewId ||
    pagination?.targetSnapshotId ||
    "default";

  const previewId = pagination?.previewId || null;

  const headings = useMemo(() => {
    if (isVariant) {
      return [
        { title: t("products:table.product", { defaultValue: "Product" }) },
        { title: t("products:table.variant", { defaultValue: "Variant" }) },
        { title: t("products:table.change", { defaultValue: "Change" }) },
      ];
    }
    return [
      { title: t("products:table.product", { defaultValue: "Product" }) },
      { title: t("products:table.change", { defaultValue: "Change" }) },
    ];
  }, [isVariant, t]);

  const toggleExpandedRow = useCallback((rowKey) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  const handleToggleExpandedRow = useCallback(
    (rowKey) => {
      toggleExpandedRow(rowKey);
    },
    [toggleExpandedRow],
  );

  const handlePreviousPage = useCallback(() => {
    if (typeof onPageChange !== "function" || page <= 1) return;
    onPageChange(page - 1);
  }, [onPageChange, page]);

  const handleNextPage = useCallback(() => {
    if (typeof onPageChange !== "function" || page >= totalPages) return;
    onPageChange(page + 1);
  }, [onPageChange, page, totalPages]);

  useEffect(() => {
    setExpandedRows(new Set());
  }, [page, resultVersion]);

  const rowFragments = useMemo(
    () =>
      safeProducts.map((product, index) => {
        const rowKey = buildPreviewRowKey(product, index);
        const variantCount = safeNonNegativeInteger(product?.variantCount, 0);
        const changedCount =
          product?.changedVariantCount !== undefined
            ? safeNonNegativeInteger(product.changedVariantCount, 0)
            : 0;
        const isExpanded = expandedRows.has(rowKey);
        const productId = safeRawString(product?.productId || product?.id, "");

        return (
          <React.Fragment key={`preview-fragment:${rowKey}`}>
            <IndexTable.Row id={rowKey} key={rowKey} position={index}>
              <IndexTable.Cell>
                <InlineStack gap="300" wrap={false} blockAlign="center">
                  <Thumbnail
                    source={product?.imageUrl || product?.img || FALLBACK_PRODUCT_IMAGE}
                    alt={formatValue(product?.title)}
                    size="small"
                  />
                  <Text as="span" truncate variant="bodyMd" fontWeight="medium">
                    {formatValue(product?.title)}
                  </Text>
                </InlineStack>
              </IndexTable.Cell>

              {isVariant ? (
                <IndexTable.Cell>
                  <InlineStack gap="200" wrap>
                    <Badge tone="info">
                      {t("products:variantCountBadge", {
                        defaultValue: "{{count}} variants",
                        count: variantCount,
                      })}
                    </Badge>
                    <Badge tone={changedCount > 0 ? "success" : "attention"}>
                      {t("products:changedVariantCountBadge", {
                        defaultValue: "{{count}} changed",
                        count: changedCount,
                      })}
                    </Badge>
                  </InlineStack>
                </IndexTable.Cell>
              ) : null}

              <IndexTable.Cell>
                {isVariant ? (
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {variantCount > 0
                        ? t("products:showingVariantCount", {
                            defaultValue: "{{count}} variants available",
                            count: variantCount,
                          })
                        : "-"}
                    </Text>

                    <Button
                      size="slim"
                      onClick={() => handleToggleExpandedRow(rowKey)}
                      disabled={variantCount === 0}
                    >
                      {isExpanded
                        ? t("products:hideVariants", { defaultValue: "Hide variants" })
                        : t("products:viewVariants", { defaultValue: "View variants" })}
                    </Button>
                  </InlineStack>
                ) : (
                  <InlineStack gap="200" align="start" wrap>
                    <Text as="span" tone="subdued" textDecorationLine="line-through">
                      {formatValue(product?.oldValue)}
                    </Text>
                    <Text as="span" variant="bodyMd" fontWeight="semibold" tone="success">
                      {formatValue(product?.newValue)}
                    </Text>
                  </InlineStack>
                )}
              </IndexTable.Cell>
            </IndexTable.Row>

            {isVariant && isExpanded ? (
              <IndexTable.Row id={`${rowKey}:variants`} key={`${rowKey}:variants`} position={index}>
                <IndexTable.Cell />
                <IndexTable.Cell colSpan={2}>
                  <Box id={`${rowKey}:variants`}>
                    <VariantDetailsSection
                      previewId={previewId}
                      productId={productId}
                      rowKey={rowKey}
                      t={t}
                    />
                  </Box>
                </IndexTable.Cell>
              </IndexTable.Row>
            ) : null}
          </React.Fragment>
        );
      }),
    [
      expandedRows,
      handleToggleExpandedRow,
      isVariant,
      previewId,
      safeProducts,
      t,
    ],
  );

  const fromItem = total === 0 ? 0 : Math.min((page - 1) * limit + 1, total);
  const toItem = total === 0 ? 0 : Math.min(page * limit, total);

  if (loading) {
    return (
      <Card>
        <Box padding="400">
          <SkeletonBodyText lines={6} />
        </Box>
      </Card>
    );
  }

  if (safeProducts.length === 0) {
    return (
      <Card>
        <EmptyState
          heading={t("products:noProductMatchFilter", {
            defaultValue: "No products match this filter",
          })}
          image={EMPTY_STATE_IMAGE}
        >
          <Text as="p" tone="subdued">
            {t("products:tryAdjustingFiltersResults", {
              defaultValue: "Try adjusting your filters to see more results.",
            })}
          </Text>
        </EmptyState>
      </Card>
    );
  }

  return (
    <BlockStack gap="400">
      <Card padding="0">
        <IndexTable
          resourceName={{
            singular: t("products:product", { defaultValue: "product" }),
            plural: t("products:products", { defaultValue: "products" }),
          }}
          itemCount={safeProducts.length}
          selectable={false}
          headings={headings}
        >
          {rowFragments}
        </IndexTable>

        <Box
          background="bg-surface-secondary"
          padding="400"
          borderBlockStartWidth="025"
          borderColor="border"
        >
          <InlineStack gap="100" blockAlign="center" align="space-between">
            <Text as="p" variant="bodySm" tone="subdued">
              {t("products:showingProductsRange", {
                defaultValue: "Showing {{from}} to {{to}} of {{total}} products",
                from: fromItem,
                to: toItem,
                total,
              })}
            </Text>

            <Pagination
              hasPrevious={page > 1}
              onPrevious={handlePreviousPage}
              hasNext={page < totalPages}
              onNext={handleNextPage}
            />
          </InlineStack>
        </Box>
      </Card>
    </BlockStack>
  );
}

export default memo(PreviewTable);
