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
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ProductCell from "./ProductCell";
import StatusBadge from "./StatusBadge";
import TableErrorBoundary from "../../../../components/Error/TableErrorBoundary";
import CellErrorBoundary from "../../../../components/Error/CellErrorBoundary";

const SKELETON_ROWS = 6;
const FALLBACK_IMAGE = "/images/fallback-2.png";
const TABLE_SHELL_MIN_HEIGHT = "420px";

function LoadingTable() {
  return (
    <Box minHeight={TABLE_SHELL_MIN_HEIGHT}>
      <Box padding="400" borderBlockEndWidth="1" borderColor="border">
        <BlockStack gap="200">
          <SkeletonDisplayText size="small" />
          <SkeletonBodyText lines={1} />
        </BlockStack>
      </Box>
      <Box padding="400">
        <SkeletonBodyText lines={SKELETON_ROWS} />
      </Box>
      <Box padding="400" borderBlockStartWidth="1" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <SkeletonBodyText lines={1} />
          <Box minWidth="120px">
            <SkeletonBodyText lines={1} />
          </Box>
        </InlineStack>
      </Box>
    </Box>
  );
}

const ProductsTable = ({ products = [], loading, pagination, onNext, onPrev }) => {
  const { t } = useTranslation(["products", "common"]);
  if (loading) return <LoadingTable />;

  if (!products.length) {
    return (
      <Box padding="1200" minHeight={TABLE_SHELL_MIN_HEIGHT}>
        <EmptyState heading={t("filteredProductsEmptyHeading")}>
          <p>{t("filteredProductsEmptyText")}</p>
        </EmptyState>
      </Box>
    );
  }

  const headings = useMemo(
    () => [
      { title: t("product") },
      { title: t("status") },
      { title: t("inventory") },
      { title: t("productType") },
      { title: t("vendor") },
    ],
    [t],
  );

  return (
    <Box minHeight={TABLE_SHELL_MIN_HEIGHT}>
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

      <TableErrorBoundary>
        <IndexTable
          resourceName={{ singular: "product", plural: "products" }}
          itemCount={products.length}
          selectable={false}
          headings={headings}
        >
          {products.map((product, index) => {
            const title = product.title ?? "";
            const handle = product.handle ?? "";
            const resolvedImage =
              product.featuredImageUrl ||
              product.featuredMedia?.preview?.image?.url ||
              FALLBACK_IMAGE;

            return (
              <IndexTable.Row id={String(product.id || index)} key={product.id || index} position={index}>
                <IndexTable.Cell>
                  <CellErrorBoundary fallback="[render error]">
                    <ProductCell title={title} handle={handle} imageUrl={resolvedImage} />
                  </CellErrorBoundary>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <CellErrorBoundary fallback="[render error]">
                    <StatusBadge status={product.status} />
                  </CellErrorBoundary>
                </IndexTable.Cell>
                <IndexTable.Cell>{product.totalInventory ?? "-"}</IndexTable.Cell>
                <IndexTable.Cell>{product.productType || "-"}</IndexTable.Cell>
                <IndexTable.Cell>{product.vendor || "-"}</IndexTable.Cell>
              </IndexTable.Row>
            );
          })}
        </IndexTable>
      </TableErrorBoundary>

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
    </Box>
  );
};

export default memo(ProductsTable);
