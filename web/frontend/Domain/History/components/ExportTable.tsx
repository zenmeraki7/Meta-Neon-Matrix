import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { toSafeErrorMessage } from "../../../utils/frontendError";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import TableErrorBoundary from "../../../components/Error/TableErrorBoundary";
import { useExportHistoryQuery } from "../hooks/useExportHistoryQuery";
import { historyService } from "../services/historyService";

export const EXPORT_TYPE = {
  MANUAL: "MANUAL",
  SCHEDULED: "SCHEDULED",
} as const;

export const EXPORT_DOWNLOAD_ERROR = {
  MISSING_ID: "EXPORT_DOWNLOAD_MISSING_ID",
  FAILED: "EXPORT_DOWNLOAD_FAILED",
} as const;

export type ExportType =
  (typeof EXPORT_TYPE)[keyof typeof EXPORT_TYPE];

export type ExportDownloadErrorCode =
  (typeof EXPORT_DOWNLOAD_ERROR)[keyof typeof EXPORT_DOWNLOAD_ERROR];

type ExportTabKey = "manual" | "scheduled";

type CursorState = {
  cursors: Array<string | null>;
  cursorIndex: number;
};

type TabQueryState = Record<ExportTabKey, CursorState>;

type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

type ExportItem = {
  id?: string | number | null;
  filename?: string | null;
  status?: string | null;
  type?: string | null;
  rawType?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
  downloadReady?: boolean | null;
  downloadUrl?: string | null;
  progressPercent?: number | string | null;
  progressSummary?: {
    percent?: number | string | null;
    label?: string | null;
  } | null;
  primaryStatus?: {
    key?: string | null;
    label?: string | null;
    detail?: string | null;
    isTerminal?: boolean | null;
  } | null;
  supportStatus?: {
    failureStage?: string | null;
  } | null;
};

export type ExportTableProps = {
  selectedType?: ExportType;
  onDownloadSuccess?: () => void;
  onDownloadError?: (
    code: ExportDownloadErrorCode,
  ) => void;
};

type ExportRowActionsProps = {
  rowId: string;
  filename: string;
  isDownloading: boolean;
  isDownloadable: boolean;
  onDownload: (rowId: string, filename: string) => void;
  downloadingLabel: string;
  downloadLabel: string;
};

type ExportHistoryRowProps = {
  item: ExportItem;
  isDownloading: boolean;
  dateTimeFormatter: Intl.DateTimeFormat;
  downloadingLabel: string;
  downloadLabel: string;
  untitledLabel: string;
  inProgressLabel: string;
  unknownStatusLabel: string;
  unavailableLabel: string;
  onDownload: (rowId: string, filename: string) => void;
  t: Translate;
};

type StatusTone =
  | "success"
  | "critical"
  | "warning"
  | "info"
  | undefined;

const DEFAULT_TAB_QUERY_STATE: TabQueryState = {
  manual: {
    cursors: [null],
    cursorIndex: 0,
  },
  scheduled: {
    cursors: [null],
    cursorIndex: 0,
  },
};

const TERMINAL_STATUSES = new Set([
  "completed",
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "partial",
  "partial_failed",
  "partially_completed",
]);

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(
    normalizeStatus(status),
  );
}

function isCompletedStatus(status: string): boolean {
  const normalized = normalizeStatus(status);
  return (
    normalized === "completed" ||
    normalized === "success"
  );
}

function normalizeProgress(
  value: unknown,
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.round(
    Math.max(0, Math.min(100, parsed)),
  );
}

function getExportTabKey(
  selectedType: ExportType,
): ExportTabKey {
  return selectedType === EXPORT_TYPE.SCHEDULED
    ? "scheduled"
    : "manual";
}

function getNormalizedExportType(
  item: ExportItem,
): string {
  return String(item.rawType || item.type || "")
    .trim()
    .toLowerCase();
}

function getExportTypeLabel(
  item: ExportItem,
  t: Translate,
  unavailableLabel: string,
): string {
  const typeKey = getNormalizedExportType(item);

  if (typeKey === "manual export" || typeKey === "manual") {
    return t("exportType.manual", { defaultValue: "Manual" });
  }

  if (typeKey === "scheduled export" || typeKey === "scheduled") {
    return t("exportType.scheduled", { defaultValue: "Scheduled" });
  }

  return item.type || unavailableLabel;
}

function normalizeStatus(status: unknown): string {
  return String(status || "pending")
    .trim()
    .toLowerCase();
}

function getStatusTone(status: string): StatusTone {
  switch (normalizeStatus(status)) {
    case "completed":
    case "success":
      return "success";

    case "failed":
    case "error":
      return "critical";

    case "partial":
    case "partial_failed":
    case "partially_completed":
      return "warning";

    case "queued":
    case "pending":
    case "running":
    case "processing":
      return "info";

    case "cancelled":
    case "canceled":
    default:
      return undefined;
  }
}

function getSupportDetail(
  item: ExportItem,
  primaryDetail: string | null | undefined,
  t: Translate,
): string | null {
  const failureStage =
    item.supportStatus?.failureStage
      ?.trim()
      .toLowerCase();

  if (failureStage) {
    return t(
      `exportFailureStage.${failureStage}`,
      {
        defaultValue: t(
          "common:exportFailureStage.generic",
          {
            defaultValue:
              "The export could not be completed.",
          },
        ),
      },
    );
  }

  return primaryDetail || null;
}

function formatExportDate(
  dateValue: string | null | undefined,
  formatter: Intl.DateTimeFormat,
  unavailableLabel: string,
): string {
  if (!dateValue) {
    return unavailableLabel;
  }

  const date = new Date(dateValue);

  if (Number.isNaN(date.getTime())) {
    return unavailableLabel;
  }

  return formatter.format(date);
}

const ExportRowActions = memo(
  function ExportRowActions({
    rowId,
    filename,
    isDownloading,
    isDownloadable,
    onDownload,
    downloadingLabel,
    downloadLabel,
  }: ExportRowActionsProps) {
    return (
      <s-button
        icon={isDownloading ? undefined : "download"}
        variant="tertiary"
        loading={isDownloading}
        disabled={!isDownloadable || isDownloading}
        accessibilityLabel={
          isDownloading
            ? downloadingLabel
            : `${downloadLabel}: ${filename}`
        }
        onClick={() => onDownload(rowId, filename)}
      >
        {isDownloading
          ? downloadingLabel
          : downloadLabel}
      </s-button>
    );
  },
);

const ExportHistoryRow = memo(
  function ExportHistoryRow({
    item,
    isDownloading,
    dateTimeFormatter,
    downloadingLabel,
    downloadLabel,
    untitledLabel,
    inProgressLabel,
    unknownStatusLabel,
    unavailableLabel,
    onDownload,
    t,
  }: ExportHistoryRowProps) {
    const id = String(item.id ?? "").trim();

    const rawStatus = normalizeStatus(item.status);

    const primaryStatus = item.primaryStatus || {
      key: rawStatus,
      label: t(`historyStatus.${rawStatus}`, {
        defaultValue:
          String(item.status || unknownStatusLabel),
      }),
      detail: null,
      isTerminal: false,
    };

    const statusKey = normalizeStatus(
      primaryStatus.key || rawStatus,
    );

    const statusLabel =
      primaryStatus.label ||
      t(`historyStatus.${statusKey}`, {
        defaultValue:
          String(item.status || unknownStatusLabel),
      });

    const filename =
      item.filename?.trim() || untitledLabel;

    const isDownloadable =
      isCompletedStatus(statusKey) &&
      Boolean(
        item.downloadReady ||
          item.downloadUrl,
      );

    const progress = normalizeProgress(
      item.progressSummary?.percent ??
        item.progressPercent,
    );

    const supportDetail = getSupportDetail(
      item,
      primaryStatus.detail,
      t,
    );

    const terminal =
      typeof primaryStatus.isTerminal === "boolean"
        ? primaryStatus.isTerminal
        : isTerminalStatus(statusKey);

    const timeContent = terminal
      ? formatExportDate(
          item.completedAt || item.createdAt,
          dateTimeFormatter,
          unavailableLabel,
        )
      : primaryStatus.detail || inProgressLabel;

    const statusTone = getStatusTone(statusKey);

    return (
      <s-table-row>
        <s-table-cell>
          <s-stack gap="small-200">
            <s-text type="strong">
              {filename}
            </s-text>

            <s-text color="subdued">
              {id}
            </s-text>
          </s-stack>
        </s-table-cell>

        <s-table-cell>
          <s-stack gap="small-200">
            <s-text type="strong">
              {progress === null
                ? unavailableLabel
                : t("exportProgressPercent", {
                    defaultValue:
                      "{{progress}}% complete",
                    progress,
                  })}
            </s-text>

            {item.progressSummary?.label ? (
              <s-text color="subdued">
                {item.progressSummary.label}
              </s-text>
            ) : null}
          </s-stack>
        </s-table-cell>

        <s-table-cell>
          <s-text>
            {getExportTypeLabel(item, t, unavailableLabel)}
          </s-text>
        </s-table-cell>

        <s-table-cell>
          <s-stack gap="small-200">
            <s-badge
              {...(statusTone
                ? { tone: statusTone }
                : {})}
            >
              {statusLabel}
            </s-badge>

            {supportDetail ? (
              <s-text color="subdued">
                {supportDetail}
              </s-text>
            ) : null}
          </s-stack>
        </s-table-cell>

        <s-table-cell>
          <s-text color="subdued">
            {timeContent}
          </s-text>
        </s-table-cell>

        <s-table-cell>
          <ExportRowActions
            rowId={id}
            filename={filename}
            isDownloading={isDownloading}
            isDownloadable={isDownloadable}
            onDownload={onDownload}
            downloadingLabel={downloadingLabel}
            downloadLabel={downloadLabel}
          />
        </s-table-cell>
      </s-table-row>
    );
  },
);

function ExportTable({
  selectedType = EXPORT_TYPE.MANUAL,
  onDownloadSuccess,
  onDownloadError,
}: ExportTableProps) {
  const { t } = useTranslation(["history", "common"]);
  const {
    dateTimeFormatter,
    numberFormatter,
  } = useLocaleFormatters();

  const [downloadingItems, setDownloadingItems] =
    useState<Set<string>>(() => new Set());

  const downloadingItemsRef =
    useRef<Set<string>>(new Set());

  const [tabQueryState, setTabQueryState] =
    useState<TabQueryState>(
      DEFAULT_TAB_QUERY_STATE,
    );

  const activeTabKey =
    getExportTabKey(selectedType);

  const activeCursorState =
    tabQueryState[activeTabKey];

  const activeCursor =
    activeCursorState.cursors[
      activeCursorState.cursorIndex
    ] ?? null;

  const exportQuery = useExportHistoryQuery({
    selectedType,
    cursor: activeCursor,
  });

  const queryBusy =
    exportQuery.isLoading ||
    exportQuery.isFetching;

  const histories = useMemo<ExportItem[]>(() => {
    const result =
      exportQuery.data?.items ||
      exportQuery.data?.data ||
      [];

    return Array.isArray(result) ? result : [];
  }, [
    exportQuery.data?.data,
    exportQuery.data?.items,
  ]);

  const validHistories = useMemo(
    () =>
      histories.filter((item) => {
        const id = String(
          item.id ?? "",
        ).trim();

        return id.length > 0;
      }),
    [histories],
  );

  const pageInfoSource =
    exportQuery.data?.pageInfo ||
    exportQuery.data?.meta?.pageInfo ||
    {};

  const activePageInfo = useMemo(
    () => ({
      hasNextPage: Boolean(
        pageInfoSource.hasNextPage,
      ),
      hasPreviousPage:
        activeCursorState.cursorIndex > 0,
      nextCursor:
        pageInfoSource.nextCursor ||
        pageInfoSource.endCursor ||
        null,
    }),
    [
      activeCursorState.cursorIndex,
      pageInfoSource.endCursor,
      pageInfoSource.hasNextPage,
      pageInfoSource.nextCursor,
    ],
  );

  const historyError = exportQuery.error
    ? toSafeErrorMessage(
        t,
        exportQuery.error,
        "common.errors.generic",
      )
    : null;

  const showBlockingError =
    Boolean(historyError) &&
    validHistories.length === 0;

  const showEmptyState =
    !historyError &&
    !exportQuery.isLoading &&
    validHistories.length === 0;

  const showTable =
    !showBlockingError &&
    !showEmptyState;

  const handleDownloadClick = useCallback(
    async (id: string, filename: string) => {
      if (!id) {
        onDownloadError?.(
          EXPORT_DOWNLOAD_ERROR.MISSING_ID,
        );
        return;
      }

      if (downloadingItemsRef.current.has(id)) {
        return;
      }

      downloadingItemsRef.current.add(id);

      setDownloadingItems((current) => {
        const next = new Set(current);
        next.add(id);
        return next;
      });

      try {
        const result =
          await historyService.downloadExportedData(
            id,
            filename || "export.csv",
          );

        if (result?.success) {
          onDownloadSuccess?.();
          return;
        }

        onDownloadError?.(
          EXPORT_DOWNLOAD_ERROR.FAILED,
        );
      } catch {
        onDownloadError?.(
          EXPORT_DOWNLOAD_ERROR.FAILED,
        );
      } finally {
        downloadingItemsRef.current.delete(id);

        setDownloadingItems((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [
      onDownloadError,
      onDownloadSuccess,
    ],
  );

  const handleNextPage = useCallback(() => {
    if (
      queryBusy ||
      !activePageInfo.nextCursor
    ) {
      return;
    }

    setTabQueryState((current) => {
      const currentTab =
        current[activeTabKey];

      const nextIndex =
        currentTab.cursorIndex + 1;

      return {
        ...current,
        [activeTabKey]: {
          cursors: [
            ...currentTab.cursors.slice(
              0,
              nextIndex,
            ),
            activePageInfo.nextCursor,
          ],
          cursorIndex: nextIndex,
        },
      };
    });
  }, [
    activePageInfo.nextCursor,
    activeTabKey,
    queryBusy,
  ]);

  const handlePreviousPage =
    useCallback(() => {
      if (queryBusy) {
        return;
      }

      setTabQueryState((current) => {
        const currentTab =
          current[activeTabKey];

        if (currentTab.cursorIndex === 0) {
          return current;
        }

        return {
          ...current,
          [activeTabKey]: {
            ...currentTab,
            cursorIndex:
              currentTab.cursorIndex - 1,
          },
        };
      });
    }, [activeTabKey, queryBusy]);

  const downloadingLabel = t(
    "exportDownloading",
    {
      defaultValue: "Downloading...",
    },
  );

  const downloadLabel = t("exportDownload", {
    defaultValue: "Download",
  });

  const untitledLabel = t(
    "untitledExport",
    {
      defaultValue: "Untitled export",
    },
  );

  const inProgressLabel = t(
    "exportInProgress",
    {
      defaultValue: "In progress",
    },
  );

  const unknownStatusLabel = t(
    "historyStatus.unknown",
    {
      defaultValue: "Unknown",
    },
  );

  const unavailableLabel = t(
    "common:unavailable",
    {
      defaultValue: "—",
    },
  );

  return (
    <s-section
      padding="none"
      accessibilityLabel={t(
        "exportGeneratedTitle",
        {
          defaultValue: "Generated exports",
        },
      )}
    >
      <s-stack gap="none">
        <s-box
          padding="base"
          borderBlockEnd="base"
        >
          <s-grid
            gridTemplateColumns="1fr auto"
            gap="base"
            alignItems="center"
          >
            <s-stack gap="small-200">
              <s-heading>
                {t("exportGeneratedTitle", {
                  defaultValue: "Generated exports",
                })}
              </s-heading>

              <s-paragraph color="subdued">
                {t("exportGeneratedText", {
                  defaultValue:
                    "Download completed files and review recent export activity.",
                })}
              </s-paragraph>
            </s-stack>

            {!exportQuery.isLoading ? (
              <s-text color="subdued">
                {t("exportItemsOnPage", {
                  defaultValue: "{{count}} on this page",
                  count: numberFormatter.format(
                    validHistories.length,
                  ),
                })}
              </s-text>
            ) : null}
          </s-grid>
        </s-box>

        {historyError ? (
          <s-box padding="base">
            <s-banner
              heading={t("exportLoadError", {
                defaultValue:
                  "Exports could not be loaded",
              })}
              tone="critical"
            >
              <s-paragraph>
                {historyError}
              </s-paragraph>
            </s-banner>
          </s-box>
        ) : null}

        {showEmptyState ? (
          <s-grid
            gap="base"
            justifyItems="center"
            paddingBlock="large-400"
          >
            <s-grid
              gap="base"
              justifyItems="center"
              maxInlineSize="450px"
            >
              <s-heading>
                {t("noExportsYet", {
                  defaultValue: "No exports yet",
                })}
              </s-heading>

              <s-paragraph color="subdued">
                {t("exportEmptyText", {
                  defaultValue:
                    "Completed export files will appear here once a CSV has been generated.",
                })}
              </s-paragraph>
            </s-grid>
          </s-grid>
        ) : null}

        {showTable ? (
          <TableErrorBoundary>
            <s-table
              variant="auto"
              loading={queryBusy}
              paginate={
                activePageInfo.hasNextPage ||
                activePageInfo.hasPreviousPage
              }
              hasNextPage={
                activePageInfo.hasNextPage
              }
              hasPreviousPage={
                activePageInfo.hasPreviousPage
              }
              onNextPage={handleNextPage}
              onPreviousPage={
                handlePreviousPage
              }
            >
              <s-table-header-row>
                <s-table-header
                  listSlot="primary"
                  format="base"
                >
                  {t("exportColumnTitle", {
                    defaultValue: "Title",
                  })}
                </s-table-header>

                <s-table-header
                  listSlot="labeled"
                  format="numeric"
                >
                  {t("exportColumnProgress", {
                    defaultValue: "Progress",
                  })}
                </s-table-header>

                <s-table-header
                  listSlot="inline"
                  format="base"
                >
                  {t("exportColumnType", {
                    defaultValue: "Type",
                  })}
                </s-table-header>

                <s-table-header
                  listSlot="inline"
                  format="base"
                >
                  {t("exportColumnStatus", {
                    defaultValue: "Status",
                  })}
                </s-table-header>

                <s-table-header
                  listSlot="labeled"
                  format="base"
                >
                  {t("exportColumnTime", {
                    defaultValue: "Date",
                  })}
                </s-table-header>

                <s-table-header
                  listSlot="inline"
                  format="base"
                >
                  {t("exportColumnActions", {
                    defaultValue: "Actions",
                  })}
                </s-table-header>
              </s-table-header-row>

              <s-table-body>
                {validHistories.map((item) => {
                  const id = String(
                    item.id ?? "",
                  ).trim();

                  return (
                    <ExportHistoryRow
                      key={id}
                      item={item}
                      isDownloading={
                        downloadingItems.has(id)
                      }
                      dateTimeFormatter={
                        dateTimeFormatter
                      }
                      downloadingLabel={
                        downloadingLabel
                      }
                      downloadLabel={
                        downloadLabel
                      }
                      untitledLabel={
                        untitledLabel
                      }
                      inProgressLabel={
                        inProgressLabel
                      }
                      unknownStatusLabel={
                        unknownStatusLabel
                      }
                      unavailableLabel={
                        unavailableLabel
                      }
                      onDownload={
                        handleDownloadClick
                      }
                      t={t}
                    />
                  );
                })}
              </s-table-body>
            </s-table>
          </TableErrorBoundary>
        ) : null}
      </s-stack>
    </s-section>
  );
}

export default ExportTable;