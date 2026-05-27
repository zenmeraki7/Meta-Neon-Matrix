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
import { toSafeErrorMessage } from "../../../utils/frontendError";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import TableErrorBoundary from "../../../components/Error/TableErrorBoundary";
import CellErrorBoundary from "../../../components/Error/CellErrorBoundary";

const DEFAULT_PAGE_INFO = {
  hasNextPage: false,
  hasPreviousPage: false,
  nextCursor: null,
};
const EXPORT_TABLE_MIN_HEIGHT = "560px";
const STATUS_RAIL_MIN_HEIGHT = "88px";

const ExportRowActions = React.memo(function ExportRowActions({
  rowId,
  fileUrl,
  filename,
  isDownloading,
  isDownloadable,
  onDownload,
  downloadingLabel,
  downloadLabel,
}) {
  return (
    <Button
      icon={isDownloading ? undefined : ArrowDownIcon}
      disabled={!isDownloadable || isDownloading}
      loading={isDownloading}
      variant="plain"
      onClick={() => onDownload(rowId, fileUrl, filename)}
    >
      {isDownloading ? downloadingLabel : downloadLabel}
    </Button>
  );
});

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

const ExportTable = ({
  selectedType = "Manual export",
  onExportSuccess,
  onExportError,
}) => {
  const { t } = useTranslation();
  const { dateTimeFormatter, numberFormatter } = useLocaleFormatters();
  const [histories, setHistories] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(null);
  const [downloadingItems, setDownloadingItems] = useState(new Set());
  const [tabQueryState, setTabQueryState] = useState({
    manual: {
      cursors: [null],
      cursorIndex: 0,
      pageInfo: DEFAULT_PAGE_INFO,
    },
    scheduled: {
      cursors: [null],
      cursorIndex: 0,
      pageInfo: DEFAULT_PAGE_INFO,
    },
  });
  const activeTabKey = getExportTabKey(selectedType);
  const activeCursorState = tabQueryState[activeTabKey];
  const activeCursor =
    activeCursorState?.cursors?.[activeCursorState?.cursorIndex ?? 0] || null;
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
        const data = await protectedApiGet(`/api/history/export/list-summary?${params.toString()}`);

        if (isMounted) {
          setHistories(data.items || data.data || []);
          const info = data.pageInfo || data.meta?.pageInfo || {};
          setTabQueryState((prev) => ({
            ...prev,
            [activeTabKey]: {
              ...prev[activeTabKey],
              pageInfo: {
                hasNextPage: Boolean(info.hasNextPage),
                hasPreviousPage: (prev[activeTabKey]?.cursorIndex || 0) > 0,
                nextCursor: info.nextCursor || info.endCursor || null,
              },
            },
          }));
        }
      } catch (error) {
        if (isMounted) {
          setHistoryError(toSafeErrorMessage(t, error, "common.errors.generic"));
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
  }, [activeCursor, activeTabKey, selectedType, t]);

  useEffect(() => {
    const hasActiveHistory = histories.some(
      (item) => item?.primaryStatus?.isTerminal !== true,
    );

    const shouldPoll =
      String(selectedType).toLowerCase().includes("scheduled") ||
      hasActiveHistory;

    if (!shouldPoll) return undefined;

    const interval = setInterval(async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      try {
        const params = new URLSearchParams();
        params.set("type", selectedType);
        params.set("limit", "20");
        if (activeCursor) params.set("cursor", activeCursor);

        const data = await protectedApiGet(
          `/api/history/export/list-summary?${params.toString()}`,
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
                hasPreviousPage: (prev[activeTabKey]?.cursorIndex || 0) > 0,
                nextCursor: info.nextCursor || info.endCursor || null,
              },
            },
          }));
        }
      } catch {
        // silent
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [activeCursor, activeTabKey, histories, selectedType]);

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

  const headings = useMemo(
    () => [
      { title: t("exportColumnTitle") },
      { title: t("exportColumnProgress") },
      { title: t("exportColumnType") },
      { title: t("exportColumnStatus") },
      { title: t("exportColumnTime") },
      { title: t("exportColumnActions") },
    ],
    [t],
  );

  const renderTimeCell = (item) => {
    const primaryStatus = item?.primaryStatus || { key: "pending", isTerminal: false };
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
        {dateTimeFormatter.format(new Date(dateString))}
      </Text>
    );
  };

  if (historyLoading) {
    return (
      <Card>
        <Box minHeight={EXPORT_TABLE_MIN_HEIGHT} padding="400">
          <BlockStack gap="400">
            <SkeletonDisplayText size="small" />
            <SkeletonBodyText lines={10} />
          </BlockStack>
        </Box>
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
              {numberFormatter.format(histories.length)} {t("exportItems")}
            </Text>
          </InlineStack>
        </Box>

        <Box
          minHeight={STATUS_RAIL_MIN_HEIGHT}
          padding={historyError ? "400" : "0"}
          borderBlockEndWidth={historyError ? "025" : "0"}
          borderColor="border"
        >
          {historyError ? (
            <Banner tone="critical">
              <Text as="p">
                {historyError || t("exportLoadError")}
              </Text>
            </Banner>
          ) : null}
        </Box>

        {histories.length === 0 ? (
          <Box padding="1200" minHeight={EXPORT_TABLE_MIN_HEIGHT}>
            <EmptyState heading={t("noExportsYet")}>
              <p>{t("exportEmptyText")}</p>
            </EmptyState>
          </Box>
        ) : (
          <Box paddingInlineStart="600" minHeight={EXPORT_TABLE_MIN_HEIGHT}>
            <TableErrorBoundary>
              <IndexTable
                resourceName={{ singular: "export", plural: "exports" }}
                itemCount={histories.length}
                selectable={false}
                headings={headings}
              >
                {histories.map((item, index) => {
                  const id = item.id || item._id;
                  const primaryStatus = item?.primaryStatus || {
                    key: String(item?.status || "pending").toLowerCase(),
                    label: t(`historyStatus.${String(item?.status || "pending").toLowerCase()}`, {
                      defaultValue: String(item?.status || "pending"),
                    }),
                    detail: null,
                    isTerminal: false,
                  };
                  const filename = item.filename || "Untitled export";
                  const isDownloading = downloadingItems.has(id);
                  const isDownloadable =
                    primaryStatus.key === "completed" && Boolean(item.fileUrl);
                  const progress = Math.max(
                    0,
                    Math.min(100, Number(item?.progressSummary?.percent ?? item?.progressPercent ?? 0)),
                  );
                  const progressLabel =
                    item?.progressSummary?.label || primaryStatus.label;
                  const supportDetail =
                    item?.supportStatus?.failureStage || primaryStatus.detail || null;

                  return (
                    <IndexTable.Row id={id} key={id} position={index}>
                      <IndexTable.Cell>
                        <CellErrorBoundary fallback="[render error]">
                          <BlockStack gap="100">
                            <Text variant="bodyMd" as="span" fontWeight="semibold">{filename}</Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {id}
                            </Text>
                          </BlockStack>
                        </CellErrorBoundary>
                      </IndexTable.Cell>

                      <IndexTable.Cell>
                        <CellErrorBoundary fallback="[render error]">
                          <BlockStack gap="100">
                            <Box minWidth="120px">
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
                            </Box>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {progressLabel}
                            </Text>
                          </BlockStack>
                        </CellErrorBoundary>
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
                        <ExportRowActions
                          rowId={id}
                          fileUrl={item.fileUrl}
                          filename={filename}
                          isDownloading={isDownloading}
                          isDownloadable={isDownloadable}
                          onDownload={handleDownloadClick}
                          downloadingLabel={t("exportDownloading")}
                          downloadLabel={t("exportDownload")}
                        />
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </TableErrorBoundary>
            <Box padding="400">
              <Pagination
                hasNext={activePageInfo.hasNextPage}
                hasPrevious={activePageInfo.hasPreviousPage}
                onNext={() =>
                  setTabQueryState((prev) => ({
                    ...prev,
                    [activeTabKey]: {
                      ...prev[activeTabKey],
                      cursors: activePageInfo.nextCursor
                        ? [
                            ...prev[activeTabKey].cursors.slice(
                              0,
                              prev[activeTabKey].cursorIndex + 1,
                            ),
                            activePageInfo.nextCursor,
                          ]
                        : prev[activeTabKey].cursors,
                      cursorIndex: activePageInfo.nextCursor
                        ? prev[activeTabKey].cursorIndex + 1
                        : prev[activeTabKey].cursorIndex,
                    },
                  }))
                }
                onPrevious={() =>
                  setTabQueryState((prev) => ({
                    ...prev,
                    [activeTabKey]: {
                      ...prev[activeTabKey],
                      cursorIndex: Math.max(
                        0,
                        (prev[activeTabKey].cursorIndex || 0) - 1,
                      ),
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
