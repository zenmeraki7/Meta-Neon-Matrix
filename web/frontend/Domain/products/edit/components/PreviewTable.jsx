import React from "react";
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
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";

const formatValue = (value) => {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") {
    return value.text ?? value.label ?? value.value ?? JSON.stringify(value);
  }
  return String(value);
};

const PreviewTable = ({ loading, products, pagination, onPageChange, isVariant }) => {
  const { t } = useTranslation();
  const { page, totalPages, total, limit } = pagination;
  const itemsPerPage = limit;

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

  return (
    <BlockStack gap="400">
      <Card padding="0">
        <IndexTable
          resourceName={{ singular: "product", plural: "products" }}
          itemCount={products.length}
          selectable={false}
          headings={headings}
        >
          {products.map((product, index) => (
            <IndexTable.Row id={String(product.id || index)} key={product.id || index} position={index}>
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
                    {(product.variants || []).slice(0, 3).map((variant) => (
                      <Badge key={variant.id} tone="info">
                        <Text truncate>{formatValue(variant.title)}</Text>
                      </Badge>
                    ))}
                    {(product.variants?.length || 0) > 3 && (
                      <Badge tone="subdued">+{product.variants.length - 3} more</Badge>
                    )}
                  </InlineStack>
                </IndexTable.Cell>
              )}
              <IndexTable.Cell>
                {isVariant ? (
                  <BlockStack gap="200">
                    {(product.variants || []).slice(0, 3).map((variant) => (
                      <InlineStack key={variant.id} gap="200" align="start">
                        <Text as="span" tone="subdued" textDecorationLine="line-through">
                          {formatValue(variant.oldValue)}
                        </Text>
                        <Text as="span" variant="bodyMd" fontWeight="semibold" tone="success">
                          {formatValue(variant.newValue)}
                        </Text>
                      </InlineStack>
                    ))}
                    {(product.variants?.length || 0) > 3 && (
                      <Text as="span" tone="subdued" variant="bodySm">
                        Showing 3 of {product.variants.length} variants
                      </Text>
                    )}
                  </BlockStack>
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
          ))}
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

export default PreviewTable;
