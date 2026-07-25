import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Spinner,
  EmptyState,
  Pagination,
  Box,
  IndexTable,
} from "@shopify/polaris";
import { importStatusBadge } from "../../shared/components/StatusBadge";
import { protectedApiGet } from "../../../api/protectedApiClient";
import { useTranslation } from "react-i18next";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";

function getImportRowId(item) {
  if (item?.id != null && String(item.id).trim() !== "") {
    return String(item.id);
  }

  const filename = String(item?.filename || "").trim();
  const createdAt = String(item?.createdAt || "").trim();
  const status = String(item?.status || "").trim();
  return `derived:${filename}|${createdAt}|${status}`;
}

export default function ImportHistory() {
  const { t } = useTranslation(["history", "common"]);
  const { dateTimeFormatter, numberFormatter } = useLocaleFormatters();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cursorStack, setCursorStack] = useState([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
  });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const nextCursor = cursorStack[cursorIndex] || null;
      const params = new URLSearchParams({ limit: "10" });
      if (nextCursor) params.set("cursor", nextCursor);
      const result = await protectedApiGet(`/api/history/get-shop-importhistory?${params.toString()}`);
      if (result.success) {
        const payload = result.items || result.data || [];
        const info = result.pageInfo || {};
        setItems(payload);
        setPageInfo({
          hasNextPage: Boolean(info.hasNextPage),
          hasPreviousPage: cursorIndex > 0,
          nextCursor: info.nextCursor || info.endCursor || null,
        });
      }
    } finally {
      setLoading(false);
    }
  }, [cursorIndex, cursorStack]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const headings = useMemo(
    () => [
      { title: t("historyImportFileName", { defaultValue: "File Name" }) },
      { title: t("historyImportStatus", { defaultValue: "Status" }) },
      { title: t("historyImportTotalRows", { defaultValue: "Total Rows" }) },
      { title: t("historyImportDate", { defaultValue: "Date" }) },
      { title: t("historyImportActions", { defaultValue: "Actions" }) },
    ],
    [t],
  );

  const rowMarkup = useMemo(
    () =>
      items.map((item, index) => {
        const rowId = getImportRowId(item);
        return (
        <IndexTable.Row id={rowId} key={rowId} position={index}>
          <IndexTable.Cell>
            <BlockStack gap="050">
              <Text as="span" variant="bodyMd" fontWeight="medium">
                {item.filename || t("historyImportUntitled", { defaultValue: "Untitled import" })}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {String(item.id || "-")}
              </Text>
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            {importStatusBadge(item.status, String(item.status || "Unknown"))}
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="100" blockAlign="center">
              <Text as="span">{numberFormatter.format(Number(item.totalRows || 0))}</Text>
              <Text as="span" tone="subdued" variant="bodySm">
                {t("historyImportRowsLabel", { defaultValue: "rows" })}
              </Text>
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" variant="bodySm">
              {item.createdAt ? dateTimeFormatter.format(new Date(item.createdAt)) : "-"}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Button variant="plain" size="slim">{t("view", { defaultValue: "View" })}</Button>
          </IndexTable.Cell>
        </IndexTable.Row>
      )}),
    [items, t, numberFormatter, dateTimeFormatter],
  );

  if (loading) {
    return (
      <Page title={t("historyImportTitle", { defaultValue: "Import History" })} compactTitle fullWidth>
        <Card>
          <Box padding="800" textAlign="center">
            <Spinner size="large" accessibilityLabel={t("loading", { defaultValue: "Loading..." })} />
          </Box>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title={t("historyImportTitle", { defaultValue: "Import History" })}
      subtitle={t("historyImportSubtitle", { defaultValue: "View and manage your product import history" })}
      compactTitle
      fullWidth
    >
      <BlockStack gap="500">
        <Card>
          {items.length === 0 ? (
            <EmptyState heading={t("historyImportEmptyTitle", { defaultValue: "No import history found" })}>
              <p>{t("historyImportEmptyText", { defaultValue: "When you import CSV files, they will appear here." })}</p>
            </EmptyState>
          ) : (
            <>
              <Box paddingInlineStart="600">
                <IndexTable
                  resourceName={{ singular: "import", plural: "imports" }}
                  itemCount={items.length}
                  selectable={false}
                  headings={headings}
                >
                  {rowMarkup}
                </IndexTable>
              </Box>

              <Box padding="400">
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={pageInfo.hasPreviousPage}
                    hasNext={pageInfo.hasNextPage}
                    onPrevious={() => setCursorIndex((prev) => Math.max(0, prev - 1))}
                    onNext={() => {
                      if (!pageInfo.nextCursor) return;
                      setCursorStack((prev) => [...prev.slice(0, cursorIndex + 1), pageInfo.nextCursor]);
                      setCursorIndex((prev) => prev + 1);
                    }}
                  />
                </InlineStack>
              </Box>
            </>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
