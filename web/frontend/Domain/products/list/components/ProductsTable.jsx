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
import { useSelector } from "react-redux";
import ProductCell from "./ProductCell";
import StatusBadge from "./StatusBadge";
import TableErrorBoundary from "../../../../components/Error/TableErrorBoundary";
import CellErrorBoundary from "../../../../components/Error/CellErrorBoundary";
import { makeSelectProductRowViewModel } from "../../../../store/slices/productSlice";

const SKELETON_ROWS = 6;
const TABLE_SHELL_MIN_HEIGHT = "420px";

const LoadingTable = memo(function LoadingTable() {
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
});

const ProductRow = memo(function ProductRow({ rowId, index }) {
  const selectRowViewModel = useMemo(makeSelectProductRowViewModel, []);
  const row = useSelector((state) => selectRowViewModel(state, rowId));
  if (!row) {
    return (
      <IndexTable.Row id={rowId} key={rowId} position={index}>
        <IndexTable.Cell>
          <SkeletonBodyText lines={1} />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <SkeletonBodyText lines={1} />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <SkeletonBodyText lines={1} />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <SkeletonBodyText lines={1} />
        </IndexTable.Cell>
        <IndexTable.Cell>
          <SkeletonBodyText lines={1} />
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  }

  return (
    <IndexTable.Row id={rowId} key={rowId} position={index}>
      <IndexTable.Cell>
        <CellErrorBoundary fallback="[render error]">
          <ProductCell title={row.title} handle={row.handle} imageUrl={row.featuredImageUrl} />
        </CellErrorBoundary>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <CellErrorBoundary fallback="[render error]">
          <StatusBadge status={row.status} />
        </CellErrorBoundary>
      </IndexTable.Cell>
      <IndexTable.Cell>{row.totalInventory}</IndexTable.Cell>
      <IndexTable.Cell>{row.productType}</IndexTable.Cell>
      <IndexTable.Cell>{row.vendor}</IndexTable.Cell>
    </IndexTable.Row>
  );
});

const ProductsTable = memo(function ProductsTable({
  productIds = [],
  loading,
  pagination,
  onNext,
  onPrev,
  emptyHeading = null,
  emptyText = null,
}) {
  const { t, i18n } = useTranslation(["products", "common"]);

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

  const resourceName = useMemo(
    () => ({
      singular: t("product", "product"),
      plural: t("products", "products"),
    }),
    [t],
  );

  const validIds = useMemo(
    () => productIds.filter(Boolean).map((id) => String(id)),
    [productIds],
  );
  const paginationSummary = pagination
    ? t("paginationSummary", {
        page: pagination.page,
        totalPages: pagination.totalPages,
        total: pagination.total?.toLocaleString(i18n.language),
      })
    : null;

  if (loading) return <LoadingTable />;

  if (!validIds.length) {
    return (
      <Box padding="1200" minHeight={TABLE_SHELL_MIN_HEIGHT}>
        <EmptyState heading={emptyHeading || t("filteredProductsEmptyHeading", "No products found")}>
          <p>{emptyText || t("filteredProductsEmptyText", "Try adjusting your filters")}</p>
        </EmptyState>
      </Box>
    );
  }

  return (
    <Box minHeight={TABLE_SHELL_MIN_HEIGHT}>
      <Box padding="400" borderBlockEndWidth="1" borderColor="border">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <BlockStack gap="100">
            <Box paddingInlineStart="600">
              <Text as="h3" variant="headingSm">
                {t("exportFilteredProductsTitle", "Filtered products")}
              </Text>
              {paginationSummary && (
                <Text tone="subdued" variant="bodySm">
                  {paginationSummary}
                </Text>
              )}
            </Box>
          </BlockStack>
        </InlineStack>
      </Box>

      <TableErrorBoundary>
        <IndexTable
          resourceName={resourceName}
          itemCount={validIds.length}
          selectable={false}
          headings={headings}
        >
          {validIds.map((rowId, index) => (
            <ProductRow rowId={rowId} index={index} key={rowId} />
          ))}
        </IndexTable>
      </TableErrorBoundary>

      <Box padding="400" borderBlockStartWidth="1" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <Text tone="subdued" variant="bodySm">
            {t("exportFilteredProductsText", "Export applies to filtered results only")}
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
});

export default ProductsTable;
