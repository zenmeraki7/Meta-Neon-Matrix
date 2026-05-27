import React, { memo, useCallback, useMemo, useState } from "react";
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

const formatValue = (value) => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") {
    return value.text ?? value.label ?? value.value ?? JSON.stringify(value);
  }
  return String(value);
};

const VariantDetailsPanel = memo(function VariantDetailsPanel({ variants }) {
  const safeVariants = Array.isArray(variants) ? variants : [];
  if (!safeVariants.length) {
    return (
      <Text as="p" tone="subdued" variant="bodySm">
        -
      </Text>
    );
  }

  return (
    <BlockStack gap="200">
      {safeVariants.map((variant, index) => {
        const key = String(variant?.id || variant?.variantId || `variant-${index}`);
        return (
          <InlineStack key={key} gap="200" align="start">
            <Badge tone="info">{formatValue(variant?.title || `Variant ${index + 1}`)}</Badge>
            <Text as="span" tone="subdued" textDecorationLine="line-through">
              {formatValue(variant?.oldValue)}
            </Text>
            <Text as="span" variant="bodyMd" fontWeight="semibold" tone="success">
              {formatValue(variant?.newValue)}
            </Text>
          </InlineStack>
        );
      })}
    </BlockStack>
  );
});

function buildPreviewRowKey(product, index) {
  if (product?.id) return String(product.id);
  if (product?.productId) return String(product.productId);
  if (product?.handle) return `handle:${product.handle}`;
  if (product?.title) return `title:${product.title}:${index}`;
  return `preview:${index}`;
}

const PreviewTable = ({ loading, products, pagination, onPageChange, isVariant }) => {
  const { t } = useTranslation();
  const { page, totalPages, total, limit } = pagination;
  const itemsPerPage = limit;
  const [expandedRows, setExpandedRows] = useState(() => new Set());

  const toggleExpandedRow = useCallback((rowKey) => {
    setExpandedRows((previous) => {
      const next = new Set(previous);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  }, []);

  if (loading) {
    return (
      <Card>
        <Box padding="800">
          <SkeletonBodyText lines={10} />
        </Box>
      </Card>
    );
  }

  if (!products || products.length === 0) {
    return (
      <Card>
        <EmptyState
          heading={t("NoProductMatchfilter")}
          image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
        >
          <Text as="p" tone="subdued">
            {t("TryAdjustingYourFiltersResults")}
          </Text>
        </EmptyState>
      </Card>
    );
  }

  const headings = isVariant
    ? [{ title: t("table.product") }, { title: t("table.variant") }, { title: t("table.change") }]
    : [{ title: t("table.product") }, { title: t("table.change") }];
  const rowFragments = useMemo(
    () =>
      products.map((product, index) => {
        const rowKey = buildPreviewRowKey(product, index);
        const variants = Array.isArray(product?.variants) ? product.variants : [];
        const variantCount = variants.length;
        const changedCount = variants.reduce((acc, variant) => (
          String(formatValue(variant?.oldValue)) !== String(formatValue(variant?.newValue)) ? acc + 1 : acc
        ), 0);
        const isExpanded = expandedRows.has(rowKey);

        return (
          <React.Fragment key={`preview-fragment:${rowKey}`}>
            <IndexTable.Row id={rowKey} key={rowKey} position={index}>
              <IndexTable.Cell>
                <InlineStack gap="300" wrap={false} blockAlign="center">
                  <Thumbnail
                    source={product.img || "https://www.otithee.com/img/fallback/fallback-2.png"}
                    alt={product.title}
                    size="small"
                  />
                  <Text truncate variant="bodyMd" fontWeight="medium">
                    {formatValue(product.title)}
                  </Text>
                </InlineStack>
              </IndexTable.Cell>
              {isVariant && (
                <IndexTable.Cell>
                  <InlineStack gap="200" wrap>
                    <Badge tone="info">{variantCount} variants</Badge>
                    <Badge tone="success">{changedCount} changed</Badge>
                  </InlineStack>
                </IndexTable.Cell>
              )}
              <IndexTable.Cell>
                {isVariant ? (
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {variantCount > 0
                        ? t("Showing") + " " + variantCount + " " + t("variants", { defaultValue: "variants" })
                        : "-"}
                    </Text>
                    <Button
                      size="slim"
                      onClick={() => toggleExpandedRow(rowKey)}
                    >
                      {isExpanded
                        ? t("Hide variants", { defaultValue: "Hide variants" })
                        : t("View variants", { defaultValue: "View variants" })}
                    </Button>
                  </InlineStack>
                ) : (
                  <InlineStack gap="200" align="start">
                    <Text as="span" tone="subdued" textDecorationLine="line-through">
                      {formatValue(product.oldValue)}
                    </Text>
                    <Text as="span" variant="bodyMd" fontWeight="semibold" tone="success">
                      {formatValue(product.newValue)}
                    </Text>
                  </InlineStack>
                )}
              </IndexTable.Cell>
            </IndexTable.Row>
            {isVariant && isExpanded ? (
              <IndexTable.Row
                id={`${rowKey}:variants`}
                key={`${rowKey}:variants`}
                position={index}
              >
                <IndexTable.Cell />
                <IndexTable.Cell colSpan={2}>
                  <VariantDetailsPanel variants={variants} />
                </IndexTable.Cell>
              </IndexTable.Row>
            ) : null}
          </React.Fragment>
        );
      }),
    [expandedRows, isVariant, products, t, toggleExpandedRow],
  );

  return (
    <BlockStack gap="400">
      <Card padding="0">
        <IndexTable
          resourceName={{ singular: "product", plural: "products" }}
          itemCount={products.length}
          selectable={false}
          headings={headings}
        >
          {rowFragments}
        </IndexTable>

        <Box background="bg-surface-secondary" padding="400" borderBlockStartWidth="025" borderColor="border">
          <InlineStack gap="100" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">
              {t("Showing")} {(page - 1) * itemsPerPage + 1} {t("to")}{" "}
              {Math.min(page * itemsPerPage, total ?? products.length)} {t("of")} {total ?? products.length}{" "}
              {t("products")}
            </Text>

            <Pagination
              hasPrevious={page > 1}
              onPrevious={() => onPageChange(page - 1)}
              hasNext={page < totalPages}
              onNext={() => onPageChange(page + 1)}
            />
          </InlineStack>
        </Box>
      </Card>
    </BlockStack>
  );
};

export default memo(PreviewTable);
