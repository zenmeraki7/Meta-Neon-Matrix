import React, { useEffect, useMemo, useState } from "react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  ProgressBar,
  Pagination,
  SkeletonBodyText,
  SkeletonDisplayText,
  Text,
} from "@shopify/polaris";
import { ArrowDownIcon } from "@shopify/polaris-icons";
import { useTranslation } from "react-i18next";
import { exportStatusBadge } from "../../shared/components/StatusBadge";
import { protectedApiGet } from "../../../api/protectedApiClient";

const DEFAULT_PAGE_INFO = {
  hasNextPage: false,
  hasPreviousPage: false,
  nextCursor: null,
  previousCursor: null,
};

function getExportTabKey(selectedType) {
  return String(selectedType).toLowerCase().includes("scheduled")
    ? "scheduled"
    : "manual";
}

function getNormalizedExportType(item) {
  return String(item?.rawType || item?.type || "")
    .trim()
    .toLowerCase();
}

function getPrimaryStatus(item, t) {
  const statusKey = String(
    item?.primaryStatus?.key || item?.status || "pending",
  ).toLowerCase();

  if (statusKey === "completed") {
    return {
      key: "completed",
      label: t("historyStatus.completed"),
      tone: "success",
      isTerminal: true,
    };
  }

  if (statusKey === "failed") {
    return {
      key: "failed",
      label: t("historyStatus.failed"),
      tone: "critical",
      isTerminal: true,
    };
  }

  if (statusKey === "processing") {
    return {
      key: "processing",
      label: t("historyStatus.processing"),
      tone: "info",
      isTerminal: false,
    };
  }

  return {
    key: "pending",
    label: t("historyStatus.pending"),
    tone: "attention",
    isTerminal: false,
  };
}

function getExportTypeLabel(item, t) {
  const typeKey = getNormalizedExportType(item);

  if (typeKey === "manual export") {
    return t("exportType.manual");
  }

  if (typeKey === "scheduled export") {
    return t("exportType.scheduled");
  }

  return item?.type || "-";
}

function getProgressValue(item, primaryStatus) {
  const explicitProgress = Number(
    item?.progressPercent ?? item?.progressSummary?.percent,
  );

  if (Number.isFinite(explicitProgress) && explicitProgress > 0) {
    return Math.max(0, Math.min(100, explicitProgress));
  }

  if (primaryStatus.key === "completed") {
    return 100;
  }

  const processedCount = Number(item?.processedCount ?? 0);
  const totalItems = Number(item?.targetSnapshotCount ?? item?.totalItems ?? 0);

  if (totalItems > 0) {
    return Math.max(
      0,
      Math.min(100, Math.round((processedCount / totalItems) * 100)),
    );
  }

  return 0;
}

const ExportTable = ({
  selectedType = "Manual export",
  onExportSuccess,
  onExportError,
}) => {
  const { t } = useTranslation();
  const [histories, setHistories] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(null);
  const [downloadingItems, setDownloadingItems] = useState(new Set());
  const [tabQueryState, setTabQueryState] = useState({
    manual: {
      cursor: null,
      pageInfo: DEFAULT_PAGE_INFO,
    },
    scheduled: {
      cursor: null,
      pageInfo: DEFAULT_PAGE_INFO,
    },
  });
  const activeTabKey = getExportTabKey(selectedType);
  const activeCursor = tabQueryState[activeTabKey]?.cursor || null;
  const activePageInfo =
    tabQueryState[activeTabKey]?.pageInfo || DEFAULT_PAGE_INFO;

  useEffect(() => {
    let isMounted = true;

    const fetchHistories = async ({ silent = false, nextCursor = null } = {}) => {
      try {
        if (!silent) {
          setHistoryLoading(true);
        }
        setHistoryError(null);

        const params = new URLSearchParams();
        params.set("type", selectedType);
        params.set("limit", "20");
        if (nextCursor) params.set("cursor", nextCursor);
        const data = await protectedApiGet(`/api/history/get-shop-exporthistory?${params.toString()}`);
        if (!data.success) {
          throw new Error(data.message || "Failed to fetch export history");
        }

        if (isMounted) {
          setHistories(data.items || data.data || []);
          const info = data.pageInfo || data.meta?.pageInfo || {};
          setTabQueryState((prev) => ({
            ...prev,
            [activeTabKey]: {
              ...prev[activeTabKey],
              pageInfo: {
                hasNextPage: Boolean(info.hasNextPage),
                hasPreviousPage: Boolean(info.hasPreviousPage),
                nextCursor: info.nextCursor || info.endCursor || null,
                previousCursor: info.previousCursor || null,
              },
            },
          }));
        }
      } catch (error) {
        if (isMounted) {
          setHistoryError(error);
          setTabQueryState((prev) => ({
            ...prev,
            [activeTabKey]: {
              ...prev[activeTabKey],
              pageInfo: DEFAULT_PAGE_INFO,
            },
          }));
        }
      } finally {
        if (isMounted && !silent) {
          setHistoryLoading(false);
        }
      }
    };

    fetchHistories({ nextCursor: activeCursor });

    return () => {
      isMounted = false;
    };
  }, [activeCursor, activeTabKey, selectedType]);

  useEffect(() => {
    const hasActiveHistory = histories.some(
      (item) => getPrimaryStatus(item, t).isTerminal !== true,
    );

    const shouldPoll =
      String(selectedType).toLowerCase().includes("scheduled") ||
      hasActiveHistory;

    if (!shouldPoll) return undefined;

    const interval = setInterval(async () => {
      try {
        const params = new URLSearchParams();
        params.set("type", selectedType);
        params.set("limit", "20");
        if (activeCursor) params.set("cursor", activeCursor);

        const data = await protectedApiGet(
          `/api/history/get-shop-exporthistory?${params.toString()}`,
        );
        if (data.success) {
          setHistories(data.items || data.data || []);
          const info = data.pageInfo || data.meta?.pageInfo || {};
          setTabQueryState((prev) => ({
            ...prev,
            [activeTabKey]: {
              ...prev[activeTabKey],
              pageInfo: {
                hasNextPage: Boolean(info.hasNextPage),
                hasPreviousPage: Boolean(info.hasPreviousPage),
                nextCursor: info.nextCursor || info.endCursor || null,
                previousCursor: info.previousCursor || null,
              },
            },
          }));
        }
      } catch {
        // silent
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [activeCursor, activeTabKey, histories, selectedType, t]);

  const handleDownloadClick = async (id, fileUrl, filename) => {
    if (!fileUrl) {
       onExportError?.(t("exportDownloadLinkMissing"));
      return;
    }

    setDownloadingItems((prev) => new Set(prev).add(id));

    try {
      const link = document.createElement("a");
      link.href = fileUrl;
      link.download = filename || "export.csv";
      link.target = "_blank";
      document.body.appendChild(link);
      link.click();
      link.remove();

      onExportSuccess?.();
    } catch {
       onExportError?.(t("exportDownloadFailed"));
    } finally {
      setDownloadingItems((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const renderTimeCell = (item) => {
    const primaryStatus = getPrimaryStatus(item, t);
    const dateString = item.completedAt || item.createdAt;

    if (!primaryStatus.isTerminal) {
      return (
        <Text as="span" variant="bodySm" tone="subdued">
          {primaryStatus.detail || t("exportInProgress")}
        </Text>
      );
    }

    if (!dateString) {
      return (
        <Text as="span" variant="bodySm" tone="subdued">
          -
        </Text>
      );
    }

    return (
      <Text as="span" variant="bodySm" tone="subdued">
        {new Date(dateString).toLocaleString()}
      </Text>
    );
  };

  const historyRowMarkup = useMemo(
    () =>
      histories.map((item, index) => {
        const id = item.id || item._id;
        const primaryStatus = getPrimaryStatus(item, t);
        const filename = item.filename || "Untitled export";
        const isDownloading = downloadingItems.has(id);
        const isDownloadable =
          primaryStatus.key === "completed" && Boolean(item.fileUrl);
        const progress = getProgressValue(item, primaryStatus);
        const progressLabel =
          item?.progressSummary?.label || primaryStatus.label;
        const supportDetail =
          item?.supportStatus?.failureStage || primaryStatus.detail || null;

        return (
          <IndexTable.Row id={id} key={id} position={index}>
            <IndexTable.Cell>
              <BlockStack gap="100">
                <Text variant="bodyMd" as="span" fontWeight="semibold">
                  {filename}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {id}
                </Text>
              </BlockStack>
            </IndexTable.Cell>

            <IndexTable.Cell>
              <BlockStack gap="100">
                <div style={{ minWidth: "120px" }}>
                  <ProgressBar
                    progress={progress}
                    size="small"
                    tone={
                      primaryStatus.key === "failed"
                        ? "critical"
                        : primaryStatus.key === "partial"
                          ? "warning"
                          : "highlight"
                    }
                  />
                </div>
                <Text as="span" variant="bodySm" tone="subdued">
                  {progressLabel}
                </Text>
              </BlockStack>
            </IndexTable.Cell>

            <IndexTable.Cell>
              <Text as="span" variant="bodyMd">
                {getExportTypeLabel(item, t)}
              </Text>
            </IndexTable.Cell>

            <IndexTable.Cell>
              <BlockStack gap="100">
                {exportStatusBadge(primaryStatus.key, primaryStatus.label)}
                {supportDetail ? (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {supportDetail}
                  </Text>
                ) : null}
              </BlockStack>
            </IndexTable.Cell>

            <IndexTable.Cell>{renderTimeCell(item)}</IndexTable.Cell>

            <IndexTable.Cell>
              <Button
                icon={isDownloading ? undefined : ArrowDownIcon}
                disabled={!isDownloadable || isDownloading}
                loading={isDownloading}
                variant="plain"
                onClick={() => handleDownloadClick(id, item.fileUrl, filename)}
              >
                {isDownloading ? t("exportDownloading") : t("exportDownload")}
              </Button>
            </IndexTable.Cell>
          </IndexTable.Row>
        );
      }),
    [downloadingItems, histories, t],
  );

  if (historyLoading) {
    return (
      <Card>
        <BlockStack gap="400">
          <SkeletonDisplayText size="small" />
          <SkeletonBodyText lines={8} />
        </BlockStack>
      </Card>
    );
  }

  return (
    <Card padding="0">
      <BlockStack gap="0">
        <Box
          padding="400"
          borderBlockEndWidth="025"
          borderColor="border"
          paddingInlineStart="800"
        >
          <InlineStack align="space-between" blockAlign="center">
            <BlockStack gap="100">
              <Text as="h3" variant="headingLg">
                {t("exportGeneratedTitle")}
              </Text>
              <Box paddingBlockStart="200">
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("exportGeneratedText")}
                </Text>
              </Box>
            </BlockStack>
            <Text as="span" tone="subdued" variant="bodySm">
              {histories.length} {t("exportItems")}
            </Text>
          </InlineStack>
        </Box>

        {historyError && (
          <Box padding="400" borderBlockEndWidth="025" borderColor="border">
            <Banner tone="critical">
              <Text as="p">
                {historyError.message || t("exportLoadError")}
              </Text>
            </Banner>
          </Box>
        )}

        {histories.length === 0 ? (
          <Box padding="1200">
            <EmptyState heading={t("noExportsYet")}>
              <p>{t("exportEmptyText")}</p>
            </EmptyState>
          </Box>
        ) : (
          <Box paddingInlineStart="600">
            <IndexTable
              resourceName={{ singular: "export", plural: "exports" }}
              itemCount={histories.length}
              selectable={false}
              headings={[
                { title: t("exportColumnTitle") },
                { title: t("exportColumnProgress") },
                { title: t("exportColumnType") },
                { title: t("exportColumnStatus") },
                { title: t("exportColumnTime") },
                { title: t("exportColumnActions") },
              ]}
            >
              {historyRowMarkup}
            </IndexTable>
            <Box padding="400">
              <Pagination
                hasNext={activePageInfo.hasNextPage}
                hasPrevious={activePageInfo.hasPreviousPage}
                onNext={() =>
                  setTabQueryState((prev) => ({
                    ...prev,
                    [activeTabKey]: {
                      ...prev[activeTabKey],
                      cursor: activePageInfo.nextCursor || null,
                    },
                  }))
                }
                onPrevious={() =>
                  setTabQueryState((prev) => ({
                    ...prev,
                    [activeTabKey]: {
                      ...prev[activeTabKey],
                      cursor: activePageInfo.previousCursor || null,
                    },
                  }))
                }
              />
            </Box>
          </Box>
        )}
      </BlockStack>
    </Card>
  );
};

export default ExportTable;
