import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  Page,
  Card,
  Tabs,
  BlockStack,
  Box,
  Text,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import PageLoader from "../../../components/PageLoader";

const HistoryComponent = lazy(() => import("../components/HistoryComponent"));
const ExportComponent = lazy(() => import("../components/ExportComponent"));

export default function HistoryPage() {
  const location = useLocation();
  const { t } = useTranslation();
  const navigate = useNavigate();

  const parentTabs = useMemo(
    () => [
      {
        id: "edit",
        content: t("edit"),
        accessibilityLabel: t("editHistoryTab"),
      },
      {
        id: "export",
        content: t("export"),
        accessibilityLabel: t("exportHistoryTab"),
      },
    ],
    [t],
  );

  const [selectedParentTab, setSelectedParentTab] = useState(0);

  useEffect(() => {
    try {
      const savedTab = localStorage.getItem("selectedHistoryTab");
      if (savedTab != null) {
        setSelectedParentTab(Number(savedTab) || 0);
      }
    } catch {
      // Ignore storage access failures.
    }
  }, []);

  const handleParentTabChange = useCallback((index) => {
    setSelectedParentTab(index);
    localStorage.setItem("selectedHistoryTab", index);
  }, []);

  useEffect(() => {
    if (location.state?.openExport) {
      setSelectedParentTab(1);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  const activeTabLabel =
    selectedParentTab === 0 ? t("edit") : t("export");

  return (
    <Page fullWidth title={t("history")} subtitle={t("TrackYourHistory")}
  backAction={{
    content: t("Products"),
    onAction: () => navigate("/products"),
  }}>
      <BlockStack gap="500">
        <Card>
          <Box padding="600">
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="start" wrap gap="300">
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="h1" variant="headingLg">
                      {t("historyNext")}
                    </Text>
                    <Badge tone="info">{activeTabLabel}</Badge>
                  </InlineStack>

                  <Text as="p" variant="bodyMd" tone="subdued">
                    {t("historyOverviewText",)}
                  </Text>
                </BlockStack>
              </InlineStack>

              <Box
                background="bg-surface-secondary"
                borderRadius="300"
                padding="200"
              >
                <Tabs
                  tabs={parentTabs}
                  selected={selectedParentTab}
                  onSelect={handleParentTabChange}
                  fitted
                />
              </Box>
            </BlockStack>
          </Box>
        </Card>

        <Card padding="0">
          <Suspense fallback={<PageLoader />}>
            {selectedParentTab === 0 ? <HistoryComponent /> : <ExportComponent />}
          </Suspense>
        </Card>
      </BlockStack>
    </Page>
  );
}
