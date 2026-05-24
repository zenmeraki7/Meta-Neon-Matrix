import {
  Banner,
  Card,
  Text,
  Select,
  BlockStack,
  InlineStack,
  IndexTable,
  Pagination,
} from "@shopify/polaris";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getProductFields } from "../constants";

const PREVIEW_PAGE_SIZE = 25;
const LOCAL_PREVIEW_MAX_ROWS = 200;

export default function CsvPreviewTable({ parsedData, columnMappings, onMappingChange }) {
  const { t } = useTranslation();
  const productFields = getProductFields(t);
  const [page, setPage] = useState(1);

  if (!parsedData.length) return null;

  const headers = Object.keys(parsedData[0]);
  // TODO(staging-only): switch preview to backend pagination by upload token
  // (/api/products/csv/preview?uploadToken=...&cursor=...&limit=...) and remove
  // this local bounded preview once server cursor paging is available.
  const previewRows = useMemo(
    () => parsedData.slice(0, LOCAL_PREVIEW_MAX_ROWS),
    [parsedData],
  );
  const totalPages = Math.max(1, Math.ceil(previewRows.length / PREVIEW_PAGE_SIZE));
  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const pageRows = useMemo(() => {
    const start = (page - 1) * PREVIEW_PAGE_SIZE;
    return previewRows.slice(start, start + PREVIEW_PAGE_SIZE);
  }, [previewRows, page]);

  return (
    <Card>
      <BlockStack gap="300">
        <Text variant="headingSm">{t("spreadsheetPreviewMapColumns")}</Text>
        {parsedData.length > LOCAL_PREVIEW_MAX_ROWS ? (
          <Banner tone="warning">
            <Text as="p" variant="bodySm">
              {t("spreadsheetPreviewStagingOnlyWarning", {
                defaultValue:
                  "Staging-only exception: showing first {{count}} rows until server preview pagination is enabled.",
                count: LOCAL_PREVIEW_MAX_ROWS,
              })}
            </Text>
          </Banner>
        ) : null}

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
          {pageRows.map((row, rowIndex) => (
            <IndexTable.Row id={String(rowIndex)} key={String(rowIndex)} position={rowIndex}>
              {headers.map((header) => (
                <IndexTable.Cell key={`${rowIndex}-${header}`}>
                  {String(row?.[header] ?? "")}
                </IndexTable.Cell>
              ))}
            </IndexTable.Row>
          ))}
        </IndexTable>

        <InlineStack align="space-between">
          <Text tone="subdued">
            {t("spreadsheetRowsLoaded", {
              defaultValue: "{{count}} preview rows loaded",
              count: previewRows.length,
            })}
          </Text>
          <Pagination
            hasPrevious={page > 1}
            hasNext={page < totalPages}
            onPrevious={() => setPage((current) => Math.max(1, current - 1))}
            onNext={() => setPage((current) => Math.min(totalPages, current + 1))}
          />
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
