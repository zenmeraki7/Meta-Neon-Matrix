import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Card,
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
  Thumbnail,
  Collapsible,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { usePreviewVariantDetailsQuery } from "../hooks/usePreviewVariantDetailsQuery";

const FALLBACK_PRODUCT_IMAGE = "/assets/product-placeholder.svg";
const EMPTY_STATE_IMAGE = "/assets/empty-preview.svg";

const MAX_DISPLAY_VALUE_LENGTH = 160;
const MAX_STRUCTURED_VALUE_LENGTH = 600;
const MAX_EXPANDED_VARIANTS = 25;
const VARIANT_DETAILS_PAGE_LIMIT = 25;

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
    return safeString(formatStructuredValue(value));
  }
  return safeString(value);
}

function formatStructuredValue(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return formatValue(value);
  }
}

function getShortProductId(product) {
  const productId = safeRawString(product?.productId || product?.id, "");
  if (!productId) return "";
  return productId.length > 8 ? productId.slice(-8) : productId;
}

function getSecondaryProductIdentifier(product) {
  const handle = safeRawString(product?.handle, "");
  if (handle) return handle;

  const sku = safeRawString(product?.sku || product?.variantSku, "");
  if (sku) return `SKU ${sku}`;

  const shortId = getShortProductId(product);
  return shortId ? `ID ${shortId}` : "";
}

function isObjectValue(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getFieldRendererType(field) {
  const normalized = safeRawString(field, "").toLowerCase();

  if (normalized.includes("price") || normalized.includes("cost")) return "money";
  if (normalized.includes("inventory") || normalized.includes("quantity")) return "inventory";
  if (normalized.includes("metafield")) return "metafield";
  if (normalized.includes("seo") || normalized.includes("meta")) return "seo";
  if (normalized.includes("tag")) return "tag";
  if (normalized.includes("collection")) return "collection";
  if (normalized.includes("json")) return "json";

  return "generic";
}

const StructuredValuePreview = memo(function StructuredValuePreview({ value }) {
  const [open, setOpen] = useState(false);
  const structured = formatStructuredValue(value);
  const isLong = structured.length > MAX_STRUCTURED_VALUE_LENGTH;
  const preview = isLong
    ? `${structured.slice(0, MAX_STRUCTURED_VALUE_LENGTH)}...`
    : structured;

  const handleToggle = useCallback(() => setOpen((prev) => !prev), []);

  return (
    <BlockStack gap="100">
      <Text as="span" variant="bodySm">
        {preview}
      </Text>
      {isLong ? (
        <BlockStack gap="100">
          <Button onClick={handleToggle} variant="plain" size="micro">
            {open ? "Hide full diff" : "View full diff"}
          </Button>
          <Collapsible open={open} id="structured-diff-collapsible">
            <Box background="bg-surface-secondary" padding="200" borderRadius="100">
              <Text as="pre" variant="bodySm">
                {structured}
              </Text>
            </Box>
          </Collapsible>
        </BlockStack>
      ) : null}
    </BlockStack>
  );
});

const GenericDiffValue = memo(function GenericDiffValue({ value, old }) {
  if (isObjectValue(value) || Array.isArray(value)) {
    return <StructuredValuePreview value={value} />;
  }

  return (
    <Text
      as="span"
      tone={old ? "subdued" : undefined}
      textDecorationLine={old ? "line-through" : undefined}
      variant={old ? "bodySm" : "bodyMd"}
      fontWeight={old ? undefined : "semibold"}
    >
      {formatValue(value)}
    </Text>
  );
});

const MoneyDiff = memo(function MoneyDiff({ value, old }) {
  return <GenericDiffValue value={value} old={old} />;
});

const InventoryDiff = memo(function InventoryDiff({ value, old }) {
  return <GenericDiffValue value={value} old={old} />;
});

const MetafieldDiff = memo(function MetafieldDiff({ value, old }) {
  return <GenericDiffValue value={value} old={old} />;
});

const SeoDiff = memo(function SeoDiff({ value, old }) {
  return <GenericDiffValue value={value} old={old} />;
});

const TagDiff = memo(function TagDiff({ value, old }) {
  return <GenericDiffValue value={value} old={old} />;
});

const CollectionDiff = memo(function CollectionDiff({ value, old }) {
  return <GenericDiffValue value={value} old={old} />;
});

const JsonMetafieldDiff = memo(function JsonMetafieldDiff({ value, old }) {
  return <GenericDiffValue value={value} old={old} />;
});

const DiffValue = memo(function DiffValue({ field, value, old = false }) {
  const rendererType = getFieldRendererType(field);

  switch (rendererType) {
    case "money":
      return <MoneyDiff value={value} old={old} />;
    case "inventory":
      return <InventoryDiff value={value} old={old} />;
    case "metafield":
      return <MetafieldDiff value={value} old={old} />;
    case "seo":
      return <SeoDiff value={value} old={old} />;
    case "tag":
      return <TagDiff value={value} old={old} />;
    case "collection":
      return <CollectionDiff value={value} old={old} />;
    case "json":
      return <JsonMetafieldDiff value={value} old={old} />;
    default:
      return <GenericDiffValue value={value} old={old} />;
  }
});

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

function buildPreviewRowKey(product) {
  const snapshotItemId = safeRawString(product?.snapshotItemId, "");
  const productId = safeRawString(product?.productId || product?.id, "");
  const variantId = safeRawString(product?.variantId, "");

  if (snapshotItemId) return `snapshot:${snapshotItemId}`;
  if (productId && variantId) return `product:${productId}:variant:${variantId}`;
  if (productId) return `product:${productId}`;

  throw new Error("Preview row is missing stable identity.");
}

function getPreviewRowKey(product) {
  try {
    return buildPreviewRowKey(product);
  } catch {
    return null;
  }
}

const ResilientProductThumbnail = memo(function ResilientProductThumbnail({
  source,
  alt,
}) {
  const resolvedSource = safeRawString(source, FALLBACK_PRODUCT_IMAGE);
  const [thumbnailSource, setThumbnailSource] = useState(resolvedSource);

  useEffect(() => {
    setThumbnailSource(resolvedSource);
  }, [resolvedSource]);

  const handleImageError = useCallback(() => {
    setThumbnailSource(FALLBACK_PRODUCT_IMAGE);
  }, []);

  return (
    <Thumbnail
      source={thumbnailSource}
      alt={alt}
      size="small"
      onError={handleImageError}
    />
  );
});

const VariantDetailsPanel = memo(function VariantDetailsPanel({ variants, field }) {
  const { t } = useTranslation(["products", "common"]);
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

            <DiffValue field={field} value={variant?.oldValue} old />

            <DiffValue field={field} value={variant?.newValue} />
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
  field,
}) {
  const { t } = useTranslation(["products", "common"]);
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

  if (variantDetailsQuery.isLoading) {
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
      <VariantDetailsPanel variants={rows} field={field} />

      {variantDetailsQuery.isFetching ? (
        <Text as="p" tone="subdued" variant="bodySm">
          {t("products:refreshingVariantDetails", {
            defaultValue: "Refreshing variant details...",
          })}
        </Text>
      ) : null}

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

const PreviewTableRow = memo(function PreviewTableRow({
  product,
  index,
  isVariant,
  isExpanded,
  onToggle,
  previewId,
  field,
}) {
  const { t } = useTranslation(["products", "common"]);
  const rowKey = getPreviewRowKey(product);
  const expandedRowId = `${rowKey}:variants-row`;
  const expandedPanelId = `${rowKey}:variants-panel`;
  const variantCount = safeNonNegativeInteger(product?.variantCount, 0);
  const changedCount =
    product?.changedVariantCount !== undefined
      ? safeNonNegativeInteger(product.changedVariantCount, 0)
      : 0;
  const productId = safeRawString(product?.productId || product?.id, "");
  const secondaryIdentifier = getSecondaryProductIdentifier(product);

  const handleToggle = useCallback(() => {
    if (!rowKey) return;
    onToggle(rowKey);
  }, [onToggle, rowKey]);

  if (!rowKey) return null;

  return (
    <React.Fragment>
      <IndexTable.Row id={rowKey} position={index}>
        <IndexTable.Cell>
          <InlineStack gap="300" wrap={false} blockAlign="center">
            <ResilientProductThumbnail
              source={product?.imageUrl || product?.img || FALLBACK_PRODUCT_IMAGE}
              alt={formatValue(product?.title)}
            />
            <BlockStack gap="050">
              <Text as="span" truncate variant="bodyMd" fontWeight="medium">
                {formatValue(product?.title)}
              </Text>
              {secondaryIdentifier ? (
                <Text as="span" tone="subdued" variant="bodySm">
                  {secondaryIdentifier}
                </Text>
              ) : null}
            </BlockStack>
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
              <Badge tone={changedCount > 0 ? "success" : undefined}>
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
                onClick={handleToggle}
                disabled={variantCount === 0}
                aria-expanded={isExpanded}
                aria-controls={expandedPanelId}
              >
                {isExpanded
                  ? t("products:hideVariants", { defaultValue: "Hide variants" })
                  : t("products:viewVariants", { defaultValue: "View variants" })}
              </Button>
            </InlineStack>
          ) : (
            <InlineStack gap="200" align="start" wrap>
              <DiffValue field={field} value={product?.oldValue} old />
              <DiffValue field={field} value={product?.newValue} />
            </InlineStack>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>

      {isVariant && isExpanded ? (
        <IndexTable.Row id={expandedRowId} position={index + 1}>
          <IndexTable.Cell />
          <IndexTable.Cell colSpan={isVariant ? 2 : 1}>
            <Box id={expandedPanelId}>
              <VariantDetailsSection
                previewId={previewId}
                productId={productId}
                rowKey={rowKey}
                field={field}
              />
            </Box>
          </IndexTable.Cell>
        </IndexTable.Row>
      ) : null}
    </React.Fragment>
  );
});

function PreviewTable({
  loading = false,
  products = [],
  pagination = {},
  onPageChange,
  isVariant = false,
  field = "",
}) {
  const { t } = useTranslation(["products", "common"]);
  const [expandedRowKey, setExpandedRowKey] = useState(null);

  const { validProducts, invalidRowCount } = useMemo(() => {
    if (!Array.isArray(products)) {
      return {
        validProducts: [],
        invalidRowCount: 0,
      };
    }

    const valid = [];
    let invalidCount = 0;

    for (const product of products) {
      if (getPreviewRowKey(product)) {
        valid.push(product);
      } else {
        invalidCount += 1;
      }
    }

    return {
      validProducts: valid,
      invalidRowCount: invalidCount,
    };
  }, [products]);
  const safeProducts = validProducts;
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

  const handleToggleExpandedRow = useCallback(
    (rowKey) => {
      setExpandedRowKey((current) => (current === rowKey ? null : rowKey));
    },
    [],
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
    setExpandedRowKey(null);
  }, [page, resultVersion]);

  const expandedItemCount = expandedRowKey ? 1 : 0;

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
          heading={t("products:previewEmptyHeading", {
            defaultValue: previewId
              ? "No changed preview rows"
              : "Preview is not ready",
          })}
          image={EMPTY_STATE_IMAGE}
        >
          <Text as="p" tone="subdued">
            {t("products:previewEmptyMessage", {
              defaultValue: previewId
                ? "The preview returned no changed rows. The edit may be a no-op for the current target set."
                : "Generate a preview to review product changes before running the edit.",
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
          itemCount={safeProducts.length + expandedItemCount}
          selectable={false}
          headings={headings}
        >
          {safeProducts.map((product, index) => {
            const rowKey = buildPreviewRowKey(product);

            return (
              <PreviewTableRow
                key={rowKey}
                product={product}
                index={index}
                isVariant={isVariant}
                isExpanded={expandedRowKey === rowKey}
                onToggle={handleToggleExpandedRow}
                previewId={previewId}
                field={field}
              />
            );
          })}
        </IndexTable>

        {invalidRowCount > 0 ? (
          <Box padding="400">
            <Text as="p" tone="critical" variant="bodySm">
              {t("products:invalidPreviewRowsHidden", {
                defaultValue:
                  "{{count}} preview rows were hidden because they were missing stable product identity.",
                count: invalidRowCount,
              })}
            </Text>
          </Box>
        ) : null}

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
