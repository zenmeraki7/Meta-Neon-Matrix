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
import { memo, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSelector } from "react-redux";
import ProductCell from "./ProductCell";
import StatusBadge from "./StatusBadge";
import TableErrorBoundary from "../../../../components/Error/TableErrorBoundary";
import CellErrorBoundary from "../../../../components/Error/CellErrorBoundary";
import { makeSelectProductRowViewModel } from "../../../../store/slices/productSlice";

const SKELETON_ROWS = 6;
const TABLE_SHELL_MIN_HEIGHT = "420px";
const VIRTUALIZATION_ROW_HEIGHT = 56;
const VIRTUALIZATION_VIEWPORT_HEIGHT = 520;
const VIRTUALIZATION_OVERSCAN = 8;
const VIRTUALIZATION_THRESHOLD = 30;

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

const ProductRow = memo(function ProductRow({ rowId, index }) {
  const selectRowViewModel = useMemo(makeSelectProductRowViewModel, []);
  const row = useSelector((state) => selectRowViewModel(state, rowId));
  if (!row) {
    return null;
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

const ProductsTable = ({ productIds = [], loading, pagination, onNext, onPrev }) => {
  const { t } = useTranslation(["products", "common"]);
  const [scrollTop, setScrollTop] = useState(0);
  if (loading) return <LoadingTable />;

  if (!productIds.length) {
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

  const shouldVirtualize = productIds.length > VIRTUALIZATION_THRESHOLD;
  const visibleWindow = useMemo(() => {
    if (!shouldVirtualize) {
      return {
        startIndex: 0,
        endIndex: productIds.length,
      };
    }
    const firstVisible = Math.floor(scrollTop / VIRTUALIZATION_ROW_HEIGHT);
    const visibleRows = Math.ceil(VIRTUALIZATION_VIEWPORT_HEIGHT / VIRTUALIZATION_ROW_HEIGHT);
    const startIndex = Math.max(0, firstVisible - VIRTUALIZATION_OVERSCAN);
    const endIndex = Math.min(
      productIds.length,
      firstVisible + visibleRows + VIRTUALIZATION_OVERSCAN,
    );
    return { startIndex, endIndex };
  }, [productIds.length, scrollTop, shouldVirtualize]);

  const visibleIds = useMemo(
    () => productIds.slice(visibleWindow.startIndex, visibleWindow.endIndex),
    [productIds, visibleWindow],
  );

  const topSpacerHeight = visibleWindow.startIndex * VIRTUALIZATION_ROW_HEIGHT;
  const bottomSpacerHeight =
    (productIds.length - visibleWindow.endIndex) * VIRTUALIZATION_ROW_HEIGHT;

  const handleVirtualScroll = useCallback((event) => {
    setScrollTop(event.currentTarget.scrollTop || 0);
  }, []);

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
        <Box
          maxHeight={shouldVirtualize ? `${VIRTUALIZATION_VIEWPORT_HEIGHT}px` : undefined}
          overflowY={shouldVirtualize ? "auto" : undefined}
          onScroll={shouldVirtualize ? handleVirtualScroll : undefined}
        >
          <IndexTable
            resourceName={{ singular: "product", plural: "products" }}
            itemCount={productIds.length}
            selectable={false}
            headings={headings}
          >
            {shouldVirtualize && topSpacerHeight > 0 ? (
              <IndexTable.Row id="virtual-spacer-top" position={-1}>
                <IndexTable.Cell colSpan={headings.length}>
                  <div style={{ height: `${topSpacerHeight}px` }} />
                </IndexTable.Cell>
              </IndexTable.Row>
            ) : null}

            {visibleIds.map((rawRowId, index) => {
              const rowId = String(rawRowId || "");
              if (!rowId) return null;
              const actualIndex = visibleWindow.startIndex + index;
              return <ProductRow rowId={rowId} index={actualIndex} key={rowId} />;
            })}

            {shouldVirtualize && bottomSpacerHeight > 0 ? (
              <IndexTable.Row id="virtual-spacer-bottom" position={productIds.length + 1}>
                <IndexTable.Cell colSpan={headings.length}>
                  <div style={{ height: `${bottomSpacerHeight}px` }} />
                </IndexTable.Cell>
              </IndexTable.Row>
            ) : null}
          </IndexTable>
        </Box>
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
