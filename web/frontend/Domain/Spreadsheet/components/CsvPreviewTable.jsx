import {
  Card,
  Text,
  Select,
  BlockStack,
  InlineStack,
  IndexTable,
  Pagination,
  Spinner,
} from "@shopify/polaris";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { getProductFields } from "../constants";

function buildCsvRowKey(row, headers, absoluteIndex) {
  const productId = row?.id || row?.productId || row?.product_id || "";
  const variantId = row?.variant_id || row?.variantId || "";
  if (productId || variantId) {
    return `${productId || "product"}:${variantId || "variant"}`;
  }

  const firstHeader = headers?.[0];
  const secondHeader = headers?.[1];
  const firstValue = firstHeader ? String(row?.[firstHeader] ?? "") : "";
  const secondValue = secondHeader ? String(row?.[secondHeader] ?? "") : "";
  return `${firstValue}:${secondValue}:${absoluteIndex}`;
}

export default function CsvPreviewTable({
  rows,
  headers,
  totalCount,
  loading,
  columnMappings,
  hasPreviousPage,
  hasNextPage,
  onPrevious,
  onNext,
  onMappingChange,
}) {
  const { t } = useTranslation();
  const productFields = getProductFields(t);
  if (!headers.length && !loading) return null;
  const pageRows = useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingSm">{t("spreadsheetPreviewMapColumns")}</Text>
        <InlineStack gap="200" wrap>
          {headers.map((header, index) => {
            let forcedValue = columnMappings[header] || "";
            if (index === 0) forcedValue = "id";
            if (index === 1) forcedValue = "variant_id";
            return (
              <Select
                key={header}
                label={header}
                options={productFields}
                value={forcedValue}
                onChange={(value) => {
                  if (index === 0 || index === 1) return;
                  onMappingChange(header, value);
                }}
                disabled={index === 0 || index === 1}
              />
            );
          })}
        </InlineStack>

        <IndexTable
          resourceName={{ singular: "row", plural: "rows" }}
          itemCount={pageRows.length}
          selectable={false}
          headings={headers.map((header) => ({ title: header }))}
        >
          {pageRows.map((row, rowIndex) => {
            const absoluteIndex = rowIndex;
            const rowKey = buildCsvRowKey(row, headers, absoluteIndex);
            return (
            <IndexTable.Row id={rowKey} key={rowKey} position={rowIndex}>
              {headers.map((header) => (
                <IndexTable.Cell key={`${rowKey}:${header}`}>
                  {String(row?.[header] ?? "")}
                </IndexTable.Cell>
              ))}
            </IndexTable.Row>
            );
          })}
        </IndexTable>

        <InlineStack align="space-between">
          <Text tone="subdued">
            {t("spreadsheetRowsLoaded", {
              defaultValue: "{{count}} preview rows loaded",
              count: totalCount,
            })}
          </Text>
          <InlineStack gap="200" blockAlign="center">
            {loading ? <Spinner size="small" /> : null}
            <Pagination
              hasPrevious={hasPreviousPage}
              hasNext={hasNextPage}
              onPrevious={onPrevious}
              onNext={onNext}
            />
          </InlineStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
