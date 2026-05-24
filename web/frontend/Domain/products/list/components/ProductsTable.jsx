import {
  Box,
  Text,
  EmptyState,
  InlineStack,
  Pagination,
  SkeletonBodyText,
  SkeletonDisplayText,
  BlockStack,
  IndexTable,
} from "@shopify/polaris";
import { useMemo } from "react";
import ProductCell from "./ProductCell";
import StatusBadge from "./StatusBadge";
import { t } from "i18next";

const SKELETON_ROWS = 6;
const FALLBACK_IMAGE = "/images/fallback-2.png";

function LoadingTable() {
  return (
    <>
      <Box padding="400" borderBlockEndWidth="1" borderColor="border">
        <BlockStack gap="200">
          <SkeletonDisplayText size="small" />
          <SkeletonBodyText lines={1} />
        </BlockStack>
      </Box>
      <Box padding="400">
        <SkeletonBodyText lines={SKELETON_ROWS} />
      </Box>
    </>
  );
}

export default function ProductsTable({ products = [], loading, pagination, onNext, onPrev }) {
  if (loading) return <LoadingTable />;

  if (!products.length) {
    return (
      <Box padding="1200">
        <EmptyState heading={t("filteredProductsEmptyHeading")}>
          <p>{t("filteredProductsEmptyText")}</p>
        </EmptyState>
      </Box>
    );
  }

  const rows = useMemo(
    () =>
      products.map((product, index) => {
        const title = product.title ?? "";
        const handle = product.handle ?? "";
        const resolvedImage =
          product.featuredImageUrl ||
          product.featuredMedia?.preview?.image?.url ||
          FALLBACK_IMAGE;

        return (
          <IndexTable.Row id={String(product.id || index)} key={product.id || index} position={index}>
            <IndexTable.Cell>
              <ProductCell title={title} handle={handle} imageUrl={resolvedImage} />
            </IndexTable.Cell>
            <IndexTable.Cell>
              <StatusBadge status={product.status} />
            </IndexTable.Cell>
            <IndexTable.Cell>{product.totalInventory ?? "-"}</IndexTable.Cell>
            <IndexTable.Cell>{product.productType || "-"}</IndexTable.Cell>
            <IndexTable.Cell>{product.vendor || "-"}</IndexTable.Cell>
          </IndexTable.Row>
        );
      }),
    [products],
  );

  return (
    <>
      <Box padding="400" borderBlockEndWidth="1" borderColor="border">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <BlockStack gap="100">
            <Box paddingInlineStart="600">
              <Text as="h3" variant="headingSm">
                {t("exportFilteredProductsTitle")}
              </Text>
              <Text tone="subdued" variant="bodySm">
                {t("paginationSummary", {
                  page: pagination?.page,
                  totalPages: pagination?.totalPages,
                  total: pagination?.total?.toLocaleString(),
                })}
              </Text>
            </Box>
          </BlockStack>
        </InlineStack>
      </Box>

      <IndexTable
        resourceName={{ singular: "product", plural: "products" }}
        itemCount={products.length}
        selectable={false}
        headings={[
          { title: t("product") },
          { title: t("status") },
          { title: t("inventory") },
          { title: t("productType") },
          { title: t("vendor") },
        ]}
      >
        {rows}
      </IndexTable>

      <Box padding="400" borderBlockStartWidth="1" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <Text tone="subdued" variant="bodySm">
            {t("exportFilteredProductsText")}
          </Text>
          <Pagination
            hasPrevious={pagination?.hasPrevPage}
            onPrevious={onPrev}
            hasNext={pagination?.hasNextPage}
            onNext={onNext}
          />
        </InlineStack>
      </Box>
    </>
  );
}

