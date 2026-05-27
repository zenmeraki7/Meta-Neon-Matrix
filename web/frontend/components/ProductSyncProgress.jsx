import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Page,
  Card,
  ProgressBar,
  Text,
  BlockStack,
  InlineStack,
  Icon,
  Banner,
  SkeletonBodyText,
  Box,
  Spinner,
  Button,
} from "@shopify/polaris";
import {
  RefreshIcon,
  CheckCircleIcon,
  AlertCircleIcon,
} from "@shopify/polaris-icons";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { protectedApiGet } from "../api/protectedApiClient";
const SYNC_STATUS_RAIL_MIN_HEIGHT = "88px";
const SYNC_COMPLETION_RAIL_MIN_HEIGHT = "220px";

export default function ProductSyncPage({verifyStoreAccess}) {
  const { t } = useTranslation();
  const navigate = useNavigate()
  const pollRequestIdRef = useRef(0);
  const pollTimeoutRef = useRef(null);
  const isMountedRef = useRef(true);
  const [syncStatus, setSyncStatus] = useState({
    status: "syncing",
    progress: 0,
    processedProducts: 0,
    totalProducts: 0,
    message: "Initializing sync...",
  });

  const handleGetStarted = () => {
    verifyStoreAccess()
  };

  // 🔥 POLLING API
  const stopPolling = useCallback(() => {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(async () => {
    if (!isMountedRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      pollTimeoutRef.current = setTimeout(pollOnce, 3000);
      return;
    }

    const requestId = pollRequestIdRef.current + 1;
    pollRequestIdRef.current = requestId;
    try {
      const data = await protectedApiGet(`/api/sync/product-track`);
      if (!isMountedRef.current || pollRequestIdRef.current !== requestId) {
        return;
      }

      setSyncStatus({
        progress: data.progress || 0,
        processedProducts: data.processedProducts || 0,
        totalProducts: data.totalProducts || 0,
        status: data.status,
        message: data.message,
      });

      if (data.status === "completed" || data.status === "error") {
        stopPolling();
        return;
      }
    } catch {
      // silent retry
    }

    pollTimeoutRef.current = setTimeout(pollOnce, 3000);
  }, [stopPolling]);

  useEffect(() => {
    isMountedRef.current = true;
    pollOnce();

    return () => {
      isMountedRef.current = false;
      stopPolling();
    };
  }, [pollOnce, stopPolling]);

  const getStatusBanner = () => {
    if (syncStatus.status === "completed") {
      return (
        <Banner
          title="Sync completed successfully"
          tone="success"
          icon={CheckCircleIcon}
        >
         <p>{t("productsReadyForBulkEditing")}</p>
        </Banner>
      );
    }

    // if (syncStatus.status === "error") {
    //   return (
    //     <Banner title="Sync failed" tone="critical" icon={AlertCircleIcon}>
    //       <p>{syncStatus.message}</p>
    //     </Banner>
    //   );
    // }

    return null;
  };

  return (
    <Page title="Metamatrix" subtitle="Product Bulk Edit Platform">
      <BlockStack gap="500">
        <Box minHeight={SYNC_STATUS_RAIL_MIN_HEIGHT}>{getStatusBanner()}</Box>

        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <BlockStack gap="200">
                <Text variant="headingMd" as="h2">
                  {syncStatus.status === "syncing" && "Syncing Your Products"}
                  {syncStatus.status === "completed" && "Products Synced"}
                  {/* {syncStatus.status === "error" && "Sync Failed"} */}
                </Text>
                <Text variant="bodyMd" as="p" tone="subdued">
                  {syncStatus.message}
                </Text>
              </BlockStack>

              {syncStatus.status === "syncing" && (
                <Box>
                  <Spinner size="small" />
                </Box>
              )}

              {syncStatus.status === "completed" && (
                <Icon source={CheckCircleIcon} tone="success" />
              )}

              {/* {syncStatus.status === "error" && (
                <Icon source={AlertCircleIcon} tone="critical" />
              )} */}
            </InlineStack>

            <BlockStack gap="300">
              <ProgressBar
                progress={syncStatus.progress}
                size="small"
                tone={"primary"}
              />

              <InlineStack align="space-between">
                <Text variant="bodySm" as="p" tone="subdued">
                  {syncStatus.processedProducts} of {syncStatus.totalProducts}{" "}
                  products processed
                </Text>
                <Text variant="bodySm" as="p" fontWeight="semibold">
                  {Math.round(syncStatus.progress)}%
                </Text>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>

        <Box minHeight={SYNC_COMPLETION_RAIL_MIN_HEIGHT}>
          {syncStatus.status === "completed" && (
            <Card>
              <BlockStack gap="400">
                <Text variant="headingSm" as="h3">
                  Ready to start editing!
                </Text>
                <Text variant="bodyMd" as="p" tone="subdued">
                  Your products are now available in Metamatrix. You can start
                  making bulk edits, update pricing, manage inventory, and
                  streamline your product management workflow.
                </Text>
                <Box paddingBlockStart="200">
                  <Button
                    variant="primary"
                    size="large"
                    onClick={handleGetStarted}
                  >
                    Get Started
                  </Button>
                </Box>
              </BlockStack>
            </Card>
          )}
        </Box>

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="200" blockAlign="center">
              <Icon source={RefreshIcon} tone="base" />
              <Text variant="headingSm" as="h3">
                What's happening?
              </Text>
            </InlineStack>

            <Text variant="bodyMd" as="p" tone="subdued">
              Metamatrix is importing your product catalog from Shopify. This
              process syncs all your product data including titles,
              descriptions, variants, prices, and inventory levels so you can
              edit them in bulk using our powerful platform.
            </Text>

            <BlockStack gap="200">
              <Text variant="bodySm" as="p" tone="subdued">
                • Product information and metadata
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                • Variants and pricing
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                • Inventory and SKUs
              </Text>
              <Text variant="bodySm" as="p" tone="subdued">
                • Images and collections
              </Text>
            </BlockStack>

            
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
