import React, { memo } from "react";
import {
  TextField,
  Button,
  InlineStack,
  BlockStack,
  Tabs,
  Text,
  Box,
  Card,
  Badge,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";

interface HistoryFiltersProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  onExport: () => void;
  onSaveView: () => void;
  selectedTabIndex: number;
  onTabChange: (index: number) => void;
  tabs: Array<{ id: string; content: string }>;
}

const HistoryFilters = memo<HistoryFiltersProps>(
  ({
    searchValue,
    onSearchChange,
    onExport,
    onSaveView,
    selectedTabIndex,
    onTabChange,
    tabs,
  }) => {
    const { t } = useTranslation(["history", "common"]);
    return (
      <Card>
        <Box padding="500">
          <BlockStack gap="400">
            <InlineStack
              align="space-between"
              blockAlign="start"
              wrap
              gap="300"
            >
              <BlockStack gap="100">
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Text as="h3" variant="headingMd">
                    {t("historyFiltersTitle")}
                  </Text>

                  <Badge tone="new">{t("historyFiltersBadge")}</Badge>
                </InlineStack>
                <Box paddingBlockStart="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t("historyFiltersText")}
                  </Text>
                </Box>
              </BlockStack>
            </InlineStack>

            <Box
              background="bg-surface-secondary"
              borderRadius="300"
              padding="200"
            >
              <Tabs
                tabs={tabs}
                selected={selectedTabIndex}
                onSelect={onTabChange}
              />
            </Box>

            <InlineStack
              align="space-between"
              blockAlign="center"
              gap="300"
              wrap
            >
              <Box width="100%" maxWidth="380px" minWidth="260px">
                <TextField
                  label={t("search", { defaultValue: "Search" })}
                  labelHidden
                  placeholder={t("searchHistory")}
                  value={searchValue}
                  onChange={onSearchChange}
                  clearButton
                  onClearButtonClick={() => onSearchChange("")}
                  autoComplete="off"
                />
              </Box>

              <InlineStack gap="200" wrap>
                <Button onClick={onSaveView}>
                  {t("historySaveViewButton")}
                </Button>

                <Button variant="primary" onClick={onExport}>
                  {t("historyExportButton")}
                </Button>
              </InlineStack>
            </InlineStack>
          </BlockStack>
        </Box>
      </Card>
    );
  },
);

HistoryFilters.displayName = "HistoryFilters";

export default HistoryFilters;
