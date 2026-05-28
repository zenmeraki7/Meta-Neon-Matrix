import React, { memo, useCallback, useMemo, useState } from "react";
import {
  Page,
  Card,
  ProgressBar,
  Text,
  BlockStack,
  InlineStack,
  Icon,
  Banner,
  Box,
  Spinner,
  Button,
} from "@shopify/polaris";
import {
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";
import { useProductTrackQuery } from "../hooks/useSyncStatusQuery";

const SYNC_STATUS_RAIL_MIN_HEIGHT = "88px";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "reauth_required",
]);

function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function safeCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeStatus(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return normalized || "unknown";
}

function normalizeSyncStatus(rawStatus) {
  const status = normalizeStatus(rawStatus?.status);
  const progress = clampProgress(rawStatus?.progress);
  const totalProducts = safeCount(rawStatus?.totalProducts);
  const rawProcessedProducts = safeCount(rawStatus?.processedProducts);
  const processedProducts =
    totalProducts > 0 ? Math.min(rawProcessedProducts, totalProducts) : rawProcessedProducts;

  const message =
    typeof rawStatus?.message === "string" && rawStatus.message.trim()
      ? rawStatus.message.trim()
      : null;

  return Object.freeze({
    status,
    progress,
    processedProducts,
    totalProducts,
    message,
  });
}

function isCompletedStatus(status) {
  return status === "completed";
}

function isFailedStatus(status) {
  return status === "failed" || status === "error";
}

function isCancelledStatus(status) {
  return status === "cancelled";
}

function isReauthStatus(status) {
  return status === "reauth_required";
}

function isSyncingStatus(status) {
  return status === "syncing" || status === "running" || status === "queued";
}

function isUnknownStatus(status) {
  return status === "unknown";
}

function getStatusTitle({ syncStatus, isInitialLoading, isQueryError, t }) {
  if (isInitialLoading) {
    return t("productSync.checkingStatusTitle", { defaultValue: "Checking Sync Status" });
  }
  if (isQueryError) {
    return t("productSync.unableToCheckStatusTitle", { defaultValue: "Unable to Check Sync Status" });
  }
  if (isCompletedStatus(syncStatus.status)) {
    return t("productSync.completedTitle", { defaultValue: "Products Synced" });
  }
  if (isReauthStatus(syncStatus.status)) {
    return t("productSync.reauthTitle", { defaultValue: "Reconnect Shopify Session" });
  }
  if (isCancelledStatus(syncStatus.status)) {
    return t("productSync.cancelledTitle", { defaultValue: "Sync Cancelled" });
  }
  if (isFailedStatus(syncStatus.status)) {
    return t("productSync.failedTitle", { defaultValue: "Sync Failed" });
  }
  if (isSyncingStatus(syncStatus.status)) {
    return t("productSync.syncingTitle", { defaultValue: "Syncing Your Products" });
  }
  return t("productSync.unknownTitle", { defaultValue: "Product Sync Status" });
}

function getStatusMessage({ syncStatus, isInitialLoading, isQueryError, t }) {
  if (isInitialLoading) {
    return t("productSync.checkingStatusMessage", { defaultValue: "Checking your product sync status..." });
  }
  if (isQueryError) {
    return t("common.errors.generic", { defaultValue: "Unable to fetch sync status right now." });
  }
  if (syncStatus.message) return syncStatus.message;
  if (isCompletedStatus(syncStatus.status)) {
    return t("productSync.completedMessage", { defaultValue: "Your products are ready for bulk editing." });
  }
  if (isReauthStatus(syncStatus.status)) {
    return t("productSync.reauthMessage", {
      defaultValue: "Your Shopify session needs to be refreshed before sync can continue.",
    });
  }
  if (isCancelledStatus(syncStatus.status)) {
    return t("productSync.cancelledMessage", { defaultValue: "Product sync was cancelled." });
  }
  if (isFailedStatus(syncStatus.status)) {
    return t("productSync.failedMessage", { defaultValue: "Product sync could not be completed." });
  }
  if (isSyncingStatus(syncStatus.status)) {
    return t("productSync.syncingMessage", {
      defaultValue: "Metamatrix is importing your product catalog from Shopify.",
    });
  }
  return t("productSync.unknownMessage", { defaultValue: "Product sync status is currently unavailable." });
}

function getProgressTone(syncStatus, isQueryError) {
  if (
    isQueryError ||
    isFailedStatus(syncStatus.status) ||
    isCancelledStatus(syncStatus.status) ||
    isReauthStatus(syncStatus.status)
  ) {
    return "critical";
  }
  if (isUnknownStatus(syncStatus.status)) {
    return "warning";
  }
  if (isCompletedStatus(syncStatus.status)) return "success";
  return "primary";
}

const SyncStatusBanner = memo(function SyncStatusBanner({
  syncStatus,
  isQueryError,
  queryErrorMessage,
  onRetryStatus,
  onReconnect,
  isReconnecting,
  t,
}) {
  if (isQueryError) {
    return (
      <Banner
        title={t("productSync.unableToCheckBannerTitle", { defaultValue: "Unable to check sync status" })}
        tone="critical"
        icon={AlertCircleIcon}
      >
        <BlockStack gap="200">
          <p>{queryErrorMessage}</p>
          <InlineStack>
            <Button onClick={onRetryStatus}>{t("actions.retry", { defaultValue: "Retry" })}</Button>
          </InlineStack>
        </BlockStack>
      </Banner>
    );
  }

  if (isReauthStatus(syncStatus.status)) {
    return (
      <Banner
        title={t("productSync.reauthBannerTitle", { defaultValue: "Reconnect Shopify session" })}
        tone="critical"
        icon={AlertCircleIcon}
      >
        <BlockStack gap="200">
          <p>
            {syncStatus.message ||
              t("productSync.reauthBannerMessage", {
                defaultValue: "Your Shopify session has expired. Reconnect before continuing.",
              })}
          </p>
          <InlineStack>
            <Button variant="primary" onClick={onReconnect} loading={isReconnecting} disabled={isReconnecting}>
              {t("actions.reconnect", { defaultValue: "Reconnect" })}
            </Button>
          </InlineStack>
        </BlockStack>
      </Banner>
    );
  }

  if (isFailedStatus(syncStatus.status)) {
    return (
      <Banner
        title={t("productSync.failedBannerTitle", { defaultValue: "Sync failed" })}
        tone="critical"
        icon={AlertCircleIcon}
      >
        <BlockStack gap="200">
          <p>
            {syncStatus.message ||
              t("productSync.failedBannerMessage", { defaultValue: "Product sync could not be completed." })}
          </p>
          <InlineStack>
            <Button onClick={onRetryStatus}>
              {t("actions.retryStatusCheck", { defaultValue: "Retry status check" })}
            </Button>
          </InlineStack>
        </BlockStack>
      </Banner>
    );
  }

  if (isCancelledStatus(syncStatus.status)) {
    return (
      <Banner
        title={t("productSync.cancelledBannerTitle", { defaultValue: "Sync cancelled" })}
        tone="warning"
        icon={AlertCircleIcon}
      >
        <p>
          {syncStatus.message ||
            t("productSync.cancelledBannerMessage", { defaultValue: "Product sync was cancelled." })}
        </p>
      </Banner>
    );
  }

  if (isCompletedStatus(syncStatus.status)) {
    return (
      <Banner
        title={t("productSync.completedBannerTitle", { defaultValue: "Sync completed successfully" })}
        tone="success"
        icon={CheckCircleIcon}
      >
        <p>
          {t("productSync.productsReadyForBulkEditing", {
            defaultValue: "Your products are ready for bulk editing.",
          })}
        </p>
      </Banner>
    );
  }

  if (isUnknownStatus(syncStatus.status)) {
    return (
      <Banner
        title={t("productSync.unknownBannerTitle", { defaultValue: "Unknown sync status" })}
        tone="warning"
        icon={AlertCircleIcon}
      >
        <p>
          {t("productSync.unknownBannerMessage", {
            defaultValue: "We received an unexpected sync status. Please retry status check.",
          })}
        </p>
      </Banner>
    );
  }

  return null;
});

export default function ProductSyncPage({ verifyStoreAccess }) {
  const { t } = useTranslation();
  const productTrackQuery = useProductTrackQuery();
  const { refetch } = productTrackQuery;

  const [isStarting, setIsStarting] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [startError, setStartError] = useState(null);

  const isInitialLoading = productTrackQuery.isLoading && !productTrackQuery.data;

  const syncStatus = useMemo(() => normalizeSyncStatus(productTrackQuery.data), [productTrackQuery.data]);
  const isTerminalStatus = TERMINAL_STATUSES.has(syncStatus.status);

  const queryErrorMessage = t("common.errors.generic", {
    defaultValue: "Unable to fetch sync status right now.",
  });

  const handleRetryStatus = useCallback(() => {
    refetch();
  }, [refetch]);

  const handleReconnect = useCallback(async () => {
    if (typeof verifyStoreAccess !== "function") return;
    try {
      setStartError(null);
      setIsReconnecting(true);
      await verifyStoreAccess();
      await refetch();
    } catch {
      setStartError(
        t("productSync.reconnectFailed", {
          defaultValue: "Unable to reconnect Shopify session. Please retry.",
        }),
      );
    } finally {
      setIsReconnecting(false);
    }
  }, [refetch, t, verifyStoreAccess]);

  const handleGetStarted = useCallback(async () => {
    if (isStarting) return;
    if (typeof verifyStoreAccess !== "function") {
      setStartError(
        t("productSync.openEditorUnavailable", {
          defaultValue: "Unable to open product editor. Please refresh the app and try again.",
        }),
      );
      return;
    }

    try {
      setStartError(null);
      setIsStarting(true);
      await verifyStoreAccess();
    } catch {
      setStartError(
        t("productSync.openEditorFailed", {
          defaultValue: "Unable to open product editor. Please retry.",
        }),
      );
    } finally {
      setIsStarting(false);
    }
  }, [isStarting, t, verifyStoreAccess]);

  const statusTitle = getStatusTitle({
    syncStatus,
    isInitialLoading,
    isQueryError: productTrackQuery.isError,
    t,
  });

  const statusMessage = getStatusMessage({
    syncStatus,
    isInitialLoading,
    isQueryError: productTrackQuery.isError,
    t,
  });

  const showSyncSpinner =
    isInitialLoading || (isSyncingStatus(syncStatus.status) && productTrackQuery.isFetching && !isTerminalStatus);
  const showSuccessIcon = isCompletedStatus(syncStatus.status);
  const showCriticalIcon =
    productTrackQuery.isError ||
    isFailedStatus(syncStatus.status) ||
    isCancelledStatus(syncStatus.status) ||
    isReauthStatus(syncStatus.status);

  return (
    <Page
      title={t("productSync.pageTitle", { defaultValue: "MetaMatrix" })}
      subtitle={t("productSync.pageSubtitle", { defaultValue: "Product Bulk Edit Platform" })}
    >
      <BlockStack gap="500">
        <Box minHeight={SYNC_STATUS_RAIL_MIN_HEIGHT}>
          <SyncStatusBanner
            syncStatus={syncStatus}
            isQueryError={productTrackQuery.isError}
            queryErrorMessage={queryErrorMessage}
            onRetryStatus={handleRetryStatus}
            onReconnect={handleReconnect}
            isReconnecting={isReconnecting}
            t={t}
          />
        </Box>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="200">
                <Text variant="headingMd" as="h2">
                  {statusTitle}
                </Text>
                <Text
                  variant="bodyMd"
                  as="p"
                  tone={productTrackQuery.isError || showCriticalIcon ? "critical" : "subdued"}
                >
                  {statusMessage}
                </Text>
              </BlockStack>

              {showSyncSpinner ? (
                <Box>
                  <Spinner size="small" />
                </Box>
              ) : null}
              {showSuccessIcon ? <Icon source={CheckCircleIcon} tone="success" /> : null}
              {showCriticalIcon ? <Icon source={AlertCircleIcon} tone="critical" /> : null}
            </InlineStack>

            <BlockStack gap="300">
              <ProgressBar
                progress={syncStatus.progress}
                size="small"
                tone={getProgressTone(syncStatus, productTrackQuery.isError)}
              />

              <InlineStack align="space-between">
                <Text variant="bodySm" as="p" tone="subdued">
                  {t("productSync.productsProcessed", {
                    defaultValue: "{{processedProducts}} of {{totalProducts}} products processed",
                    processedProducts: syncStatus.processedProducts,
                    totalProducts: syncStatus.totalProducts,
                  })}
                </Text>

                <Text variant="bodySm" as="p" fontWeight="semibold">
                  {Math.round(syncStatus.progress)}%
                </Text>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>

        {isCompletedStatus(syncStatus.status) ? (
          <Card>
            <BlockStack gap="400">
              <Text variant="headingSm" as="h3">
                {t("productSync.readyTitle", { defaultValue: "Ready to start editing!" })}
              </Text>

              <Text variant="bodyMd" as="p" tone="subdued">
                {t("productSync.readyMessage", {
                  defaultValue:
                    "Your products are now available in MetaMatrix. You can start making bulk edits, update pricing, manage inventory, and streamline your product management workflow.",
                })}
              </Text>

              {startError ? (
                <Banner tone="critical" icon={AlertCircleIcon}>
                  <p>{startError}</p>
                </Banner>
              ) : null}

              <Box paddingBlockStart="200">
                <Button
                  variant="primary"
                  size="large"
                  onClick={handleGetStarted}
                  loading={isStarting}
                  disabled={isStarting}
                >
                  {t("actions.getStarted", { defaultValue: "Get Started" })}
                </Button>
              </Box>
            </BlockStack>
          </Card>
        ) : null}

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <Icon source={RefreshIcon} tone="base" />
              <Text variant="headingSm" as="h3">
                {t("productSync.whatIsHappeningTitle", { defaultValue: "What's happening?" })}
              </Text>
            </InlineStack>

            <Text variant="bodyMd" as="p" tone="subdued">
              {t("productSync.whatIsHappeningMessage", {
                defaultValue:
                  "MetaMatrix is importing your product catalog from Shopify. This process syncs product data including titles, descriptions, variants, prices, and inventory levels so you can edit them in bulk.",
              })}
            </Text>

            <BlockStack gap="200">
              <Text variant="bodySm" as="p" tone="subdued">
                {t("productSync.includesProductMetadata", {
                  defaultValue: "• Product information and metadata",
                })}
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                {t("productSync.includesVariantsPricing", { defaultValue: "• Variants and pricing" })}
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                {t("productSync.includesInventorySkus", { defaultValue: "• Inventory and SKUs" })}
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                {t("productSync.includesImagesCollections", {
                  defaultValue: "• Images and collections",
                })}
              </Text>
            </BlockStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}

