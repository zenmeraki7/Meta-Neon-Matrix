import React, { useEffect, useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  Text,
  Divider,
} from "@shopify/polaris";
import { RefreshIcon, ArrowLeftIcon } from "@shopify/polaris-icons";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toSafeErrorMessage } from "../../../../utils/frontendError";
import { useLocaleFormatters } from "../../../../hooks/useLocaleFormatters";
import {
  useStartProductSyncMutation,
  useSyncStatusHelpers,
} from "../../../../hooks/useSyncStatusQuery";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import heroStyles from "../../../shared/styles/HeroSurface.module.css";

const rows = [{ key: "products", api: "/api/sync/products" }];

export default function DataSyncPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useAppToast();
  const { dateTimeFormatter } = useLocaleFormatters();
const {
  syncStatus: dataSources,
  isSyncInProgress,
  isSyncStale,
} = useSyncStatusHelpers();
  const startProductSync = useStartProductSyncMutation();

  const wasSyncingRef = useRef(false);

  const getRowLabel = useCallback(
    (key) => {
      const map = {
        products: t("products"),
      };

      return map[key] || key;
    },
    [t],
  );

  const productsSynced = Boolean(dataSources?.productsSynced);
  const syncNeeded = Boolean(dataSources?.syncNeeded);
  const productSyncNeedsAttention =
    Boolean(dataSources) &&
    syncNeeded &&
    !isSyncInProgress &&
    !startProductSync.isPending;
const isAnySyncRunning =
  !isSyncStale &&
  (
    isSyncInProgress ||
    dataSources?.isProductTypeSyncing ||
    dataSources?.isCollectionSyncing
  );

  useEffect(() => {
    const isSyncing = Boolean(isAnySyncRunning);

    if (wasSyncingRef.current && !isSyncing && dataSources) {
      showSuccess(t("syncCompletedSuccess"));
    }

    wasSyncingRef.current = Boolean(isSyncing);
  }, [dataSources, isAnySyncRunning, showSuccess, t]);

  const handleRefresh = async (row) => {
  if (!isSyncStale && (isAnySyncRunning || startProductSync.isPending)) {
    showError(t("syncAlreadyRunning"));
    return;
  }

  try {
    await startProductSync.mutateAsync({ force: true });

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["sync-status"] }),
      queryClient.invalidateQueries({ queryKey: ["product-sync-status"] }),
      queryClient.invalidateQueries({ queryKey: ["bootstrap-products"] }),
      queryClient.invalidateQueries({ queryKey: ["products"] }),
    ]);

    showSuccess(t("syncStarted", { item: getRowLabel(row.key) }));
  } catch (error) {
    showError(toSafeErrorMessage(t, error, "common.errors.generic"));
  }
};
  const getDate = useCallback(
    (key) => {
      if (!dataSources) return null;

      const map = {
        products: productsSynced ? dataSources.lastProductSyncAt : null,
      };

      return map[key] ? dateTimeFormatter.format(new Date(map[key])) : t("neverSynced");
    },
    [dataSources, dateTimeFormatter, productsSynced, t],
  );

  const isSyncingForKey = useCallback(
    (key) => {
      if (!dataSources) return null;

      const map = {
        products:
          isSyncInProgress ||
          startProductSync.isPending,
      };

      return Boolean(map[key]);
    },
    [dataSources, isSyncInProgress, startProductSync.isPending],
  );

  const getStatusTone = useCallback(
    (key) => {
      if (isSyncingForKey(key)) return "attention";
      if (key === "products" && productSyncNeedsAttention) return "warning";
      if (key === "products" && !productsSynced) return "warning";
      return "success";
    },
    [isSyncingForKey, productSyncNeedsAttention, productsSynced],
  );

  const getStatusLabel = useCallback(
    (key) => {
      if (isSyncingForKey(key)) return t("syncing");
      if (key === "products" && productSyncNeedsAttention) {
        return t("syncNeeded", { defaultValue: "Sync needed" });
      }
      if (key === "products" && !productsSynced) {
        return t("syncNeeded", { defaultValue: "Sync needed" });
      }
      return t("synced");
    },
    [isSyncingForKey, productSyncNeedsAttention, productsSynced, t],
  );

  const summaryTone =
    isAnySyncRunning || startProductSync.isPending || productSyncNeedsAttention
      ? "warning"
      : "success";

  const syncCards = useMemo(
    () =>
      rows.map((item) => (
        <Card key={item.key} roundedAbove="sm">
          <Box padding="500">
            <InlineStack
              align="space-between"
              blockAlign="center"
              wrap
              gap="400"
            >
              <BlockStack gap="150">
                <Text as="h3" variant="headingMd">
                  {getRowLabel(item.key)}
                </Text>

                {dataSources ? (
                  <Text variant="bodyMd" tone="subdued">
                    {t("lastSync")}: {getDate(item.key)}
                  </Text>
                ) : (
                  <SkeletonBodyText lines={1} />
                )}
              </BlockStack>

              <InlineStack gap="300" blockAlign="center">
                {dataSources ? (
                  <Badge tone={getStatusTone(item.key)}>
                    {getStatusLabel(item.key)}
                  </Badge>
                ) : null}

                <Button
                  icon={RefreshIcon}
                  variant="primary"
                  loading={startProductSync.isPending}
                  disabled={isAnySyncRunning || startProductSync.isPending}
                  onClick={() => handleRefresh(item)}
                >
                  {t("refreshButton")}
                </Button>
              </InlineStack>
            </InlineStack>
          </Box>
        </Card>
      )),
    [
      dataSources,
      getDate,
      getRowLabel,
      getStatusLabel,
      getStatusTone,
      isAnySyncRunning,
      startProductSync.isPending,
      t,
    ],
  );

  return (
    <Page
      backAction={{
        content: "Back",
        icon: ArrowLeftIcon,
        onAction: () => navigate("/products"),
      }}
      title={t("ShopifyData")}
      subtitle={t("SyncProducts")}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Card roundedAbove="sm">
              <Box
                padding="700"
                borderRadius="300"
                overflowX="hidden"
                overflowY="hidden"
                className={heroStyles.heroSurface}
              >
                <BlockStack gap="400">
                  <InlineStack
                    align="space-between"
                    blockAlign="start"
                    wrap
                    gap="400"
                  >
                    <BlockStack gap="150">
                      <Text as="h2" variant="headingLg">
                        {t("syncHeroTitle")}
                      </Text>
                      <Box maxWidth="720px">
                        <Text as="p" tone="subdued" variant="bodyMd">
                          {t("syncHeroText")}
                        </Text>
                      </Box>
                    </BlockStack>

                    <Badge tone={summaryTone}>
                      {isAnySyncRunning || startProductSync.isPending
                        ? t("syncBadgeInProgress")
                        : productSyncNeedsAttention
                          ? t("syncBadgeNeeded", { defaultValue: "Sync needed" })
                        : t("syncBadgeReady")}
                    </Badge>
                  </InlineStack>

                  <Box
                    padding="400"
                    borderRadius="300"
                    background="bg-surface"
                    borderWidth="025"
                    borderStyle="solid"
                    borderColor="border-secondary"
                  >
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      wrap
                      gap="400"
                    >
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm">
                          {t("syncGuidanceTitle")}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodyMd">
                          {t("syncGuidanceText")}
                        </Text>
                      </BlockStack>

                      <Badge tone="info">{t("syncWorkflowBadge")}</Badge>
                    </InlineStack>
                  </Box>
                </BlockStack>
              </Box>
            </Card>

            {(startProductSync.isPending || isAnySyncRunning) && (
              <Banner tone="warning">{t("syncRunningBanner")}</Banner>
            )}
            {productSyncNeedsAttention ? (
              <Banner tone="warning">
                {t("syncNeededBanner", {
                  defaultValue:
                    "No active product mirror is available. Run product sync to load products.",
                })}
              </Banner>
            ) : null}

            <BlockStack gap="300">{syncCards}</BlockStack>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card roundedAbove="sm">
            <Box padding="500">
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {t("mirrorDetailsTitle")}
                </Text>

                <Text as="p" tone="subdued" variant="bodyMd">
                  {t("mirrorDetailsText")}
                </Text>

                <Divider />

                <Box
                  background="bg-surface-secondary"
                  padding="400"
                  borderRadius="300"
                  borderWidth="025"
                  borderStyle="solid"
                  borderColor="border-secondary"
                >
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      {t("syncRefreshHint")}
                    </Text>
                  </BlockStack>
                </Box>
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>

    </Page>
  );
}
