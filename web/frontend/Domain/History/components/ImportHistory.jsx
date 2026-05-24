import React, { useState, useEffect, useCallback } from "react";
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

export default function ImportHistory() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(null);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
  });

  const fetchData = useCallback(async (nextCursor = null) => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ limit: "10" });
      if (nextCursor) params.set("cursor", nextCursor);
      const result = await protectedApiGet(`/api/history/get-shop-importhistory?${params.toString()}`);
      if (result.success) {
        const payload = result.items || result.data || [];
        const info = result.pageInfo || {};
        setItems(payload);
        setPageInfo({
          hasNextPage: Boolean(info.hasNextPage),
          hasPreviousPage: Boolean(info.hasPreviousPage),
          nextCursor: info.nextCursor || info.endCursor || null,
          previousCursor: info.previousCursor || null,
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(cursor);
  }, [cursor, fetchData]);

  if (loading) {
    return (
      <Page title="Import History" compactTitle fullWidth>
        <Card>
          <Box padding="800" textAlign="center">
            <Spinner size="large" />
          </Box>
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Import History" subtitle="View and manage your product import history" compactTitle fullWidth>
      <BlockStack gap="500">
        <Card>
          {items.length === 0 ? (
            <EmptyState heading="No import history found">
              <p>When you import CSV files, they will appear here.</p>
            </EmptyState>
          ) : (
            <>
              <Box paddingInlineStart="600">
                <IndexTable
                  resourceName={{ singular: "import", plural: "imports" }}
                  itemCount={items.length}
                  selectable={false}
                  headings={[
                    { title: "File Name" },
                    { title: "Status" },
                    { title: "Total Rows" },
                    { title: "Date" },
                    { title: "Actions" },
                  ]}
                >
                  {items.map((item, index) => (
                    <IndexTable.Row id={String(item.id || index)} key={String(item.id || index)} position={index}>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" variant="bodyMd" fontWeight="medium">
                            {item.filename || "Untitled import"}
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
                          <Text as="span">{Number(item.totalRows || 0).toLocaleString()}</Text>
                          <Text as="span" tone="subdued" variant="bodySm">
                            rows
                          </Text>
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodySm">
                          {item.createdAt ? new Date(item.createdAt).toLocaleString() : "-"}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Button variant="plain" size="slim">View</Button>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </Box>

              <Box padding="400">
                <InlineStack align="center">
                  <Pagination
                    hasPrevious={pageInfo.hasPreviousPage}
                    hasNext={pageInfo.hasNextPage}
                    onPrevious={() => setCursor(pageInfo.previousCursor || null)}
                    onNext={() => setCursor(pageInfo.nextCursor || null)}
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
