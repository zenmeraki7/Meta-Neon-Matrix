import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { protectedApiGet } from "../../../api/protectedApiClient";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import { toSafeErrorMessage } from "../../../utils/frontendError";

const PAGE_SIZE = 10;

type BadgeTone =
  | "success"
  | "critical"
  | "warning"
  | "info"
  | undefined;

interface ImportHistoryItem {
  id?: string | number | null;
  filename?: string | null;
  status?: string | null;
  totalRows?: string | number | null;
  createdAt?: string | number | Date | null;
  [key: string]: unknown;
}

interface ImportHistoryPageInfoSource {
  hasNextPage?: unknown;
  nextCursor?: unknown;
  endCursor?: unknown;
}

interface ImportHistoryApiResponse {
  success?: unknown;
  message?: unknown;
  items?: unknown;
  data?: unknown;
  pageInfo?: unknown;
  meta?: {
    pageInfo?: unknown;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface PaginationState {
  cursors: Array<string | null>;
  cursorIndex: number;
}

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor: string | null;
}

const INITIAL_PAGE_INFO: Readonly<PageInfo> = Object.freeze({
  hasNextPage: false,
  hasPreviousPage: false,
  nextCursor: null,
});

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function getImportRowId(
  item: ImportHistoryItem,
): string | null {
  if (item.id == null) {
    return null;
  }

  const id = String(item.id).trim();

  return id || null;
}

function isImportHistoryItem(
  value: unknown,
): value is ImportHistoryItem {
  return (
    isRecord(value) &&
    getImportRowId(value) !== null
  );
}

function normalizeApiResponse(
  value: unknown,
): ImportHistoryApiResponse {
  return isRecord(value) ? value : {};
}

function normalizePageInfoSource(
  value: unknown,
): ImportHistoryPageInfoSource {
  return isRecord(value) ? value : {};
}

function normalizeCursor(
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cursor = value.trim();

  return cursor || null;
}

function normalizeStatus(
  status: unknown,
): string {
  return String(status ?? "unknown")
    .trim()
    .toLowerCase();
}

function getStatusTone(
  status: unknown,
): BadgeTone {
  switch (normalizeStatus(status)) {
    case "completed":
    case "success":
    case "processed":
      return "success";

    case "failed":
    case "error":
      return "critical";

    case "partial":
    case "partial_failed":
    case "partially_completed":
      return "warning";

    case "pending":
    case "queued":
    case "processing":
    case "running":
      return "info";

    case "cancelled":
    case "canceled":
    default:
      return undefined;
  }
}

function getStatusLabel(
  status: unknown,
  t: (key: string, options?: { defaultValue?: string }) => string,
): string {
  const key = normalizeStatus(status);

  const labels: Record<
    string,
    { key: string; defaultValue: string }
  > = {
    completed: {
      key: "historyImportStatusCompleted",
      defaultValue: "Completed",
    },
    success: {
      key: "historyImportStatusCompleted",
      defaultValue: "Completed",
    },
    processed: {
      key: "historyImportStatusCompleted",
      defaultValue: "Completed",
    },
    failed: {
      key: "historyImportStatusFailed",
      defaultValue: "Failed",
    },
    error: {
      key: "historyImportStatusFailed",
      defaultValue: "Failed",
    },
    pending: {
      key: "historyImportStatusPending",
      defaultValue: "Pending",
    },
    queued: {
      key: "historyImportStatusQueued",
      defaultValue: "Queued",
    },
    processing: {
      key: "historyImportStatusProcessing",
      defaultValue: "Processing",
    },
    running: {
      key: "historyImportStatusProcessing",
      defaultValue: "Processing",
    },
    cancelled: {
      key: "historyImportStatusCancelled",
      defaultValue: "Cancelled",
    },
    canceled: {
      key: "historyImportStatusCancelled",
      defaultValue: "Cancelled",
    },
    partially_completed: {
      key: "historyImportStatusPartial",
      defaultValue: "Partially completed",
    },
    partial_failed: {
      key: "historyImportStatusPartial",
      defaultValue: "Partially completed",
    },
    partial: {
      key: "historyImportStatusPartial",
      defaultValue: "Partially completed",
    },
  };

  const label = labels[key];

  return label
    ? t(label.key, {
        defaultValue: label.defaultValue,
      })
    : t("historyImportUnknownStatus", {
        defaultValue: "Unknown",
      });
}

function normalizeRowCount(
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

  const count = Number(value);

  if (!Number.isFinite(count) || count < 0) {
    return null;
  }

  return Math.trunc(count);
}

function formatImportDate(
  value: string | number | Date | null | undefined,
  formatter: Intl.DateTimeFormat,
  unavailableLabel: string,
): string {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return unavailableLabel;
  }

  const date =
    value instanceof Date
      ? value
      : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return unavailableLabel;
  }

  return formatter.format(date);
}

function isAbortError(
  error: unknown,
): boolean {
  return (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) || (
    error instanceof Error &&
    error.name === "AbortError"
  );
}

function getErrorMessage(
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const message = value.trim();

  return message || null;
}

export default function ImportHistory() {
  const { t } = useTranslation([
    "history",
    "common",
  ]);

  const {
    dateTimeFormatter,
    numberFormatter,
  } = useLocaleFormatters();

  const [items, setItems] = useState<
    ImportHistoryItem[]
  >([]);

  const [loading, setLoading] =
    useState<boolean>(true);

  const [loadError, setLoadError] =
    useState<string | null>(null);

  const [pagination, setPagination] =
    useState<PaginationState>(() => ({
      cursors: [null],
      cursorIndex: 0,
    }));

  const [pageInfo, setPageInfo] =
    useState<PageInfo>(() => ({
      ...INITIAL_PAGE_INFO,
    }));

  const requestSequenceRef =
    useRef<number>(0);

  const mountedRef =
    useRef<boolean>(true);

  const requestAbortRef =
    useRef<AbortController | null>(null);

  const activeCursor =
    pagination.cursors[
      pagination.cursorIndex
    ] ?? null;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, []);

  const fetchData = useCallback(
    async (): Promise<void> => {
      requestAbortRef.current?.abort();

      const controller =
        new AbortController();

      requestAbortRef.current =
        controller;

      const requestSequence =
        requestSequenceRef.current + 1;

      requestSequenceRef.current =
        requestSequence;

      if (mountedRef.current) {
        setLoading(true);
        setLoadError(null);
      }

      try {
        const params =
          new URLSearchParams({
            limit: String(PAGE_SIZE),
          });

        if (activeCursor) {
          params.set(
            "cursor",
            activeCursor,
          );
        }

        const rawResult =
          await protectedApiGet(
            `/api/history/get-shop-importhistory?${params.toString()}`,
            {
              signal:
                controller.signal,
            },
          );

        if (
          !mountedRef.current ||
          requestSequence !==
            requestSequenceRef.current
        ) {
          return;
        }

        const result =
          normalizeApiResponse(
            rawResult,
          );

        if (result.success !== true) {
          throw new Error(
            getErrorMessage(
              result.message,
            ) ??
              "IMPORT_HISTORY_LOAD_FAILED",
          );
        }

        const payload =
          result.items ??
          result.data ??
          [];

        const responseItems =
          Array.isArray(payload)
            ? payload.filter(
                isImportHistoryItem,
              )
            : [];

        const nestedPageInfo =
          isRecord(result.meta)
            ? result.meta.pageInfo
            : undefined;

        const responsePageInfo =
          normalizePageInfoSource(
            result.pageInfo ??
              nestedPageInfo,
          );

        const nextCursor = normalizeCursor(
          responsePageInfo.nextCursor ??
            responsePageInfo.endCursor,
        );

        setItems(responseItems);

        setPageInfo({
          hasNextPage:
            Boolean(responsePageInfo.hasNextPage) &&
            nextCursor !== null,
          hasPreviousPage:
            pagination.cursorIndex > 0,
          nextCursor,
        });
      } catch (error: unknown) {
        if (
          controller.signal.aborted ||
          isAbortError(error)
        ) {
          return;
        }

        if (
          !mountedRef.current ||
          requestSequence !==
            requestSequenceRef.current
        ) {
          return;
        }

        setPageInfo((current) => ({
          ...current,
          hasPreviousPage:
            pagination.cursorIndex > 0,
        }));

        setLoadError(
          toSafeErrorMessage(
            t,
            error,
            "common.errors.generic",
          ),
        );
      } finally {
        if (
          requestAbortRef.current ===
          controller
        ) {
          requestAbortRef.current =
            null;
        }

        if (
          mountedRef.current &&
          requestSequence ===
            requestSequenceRef.current
        ) {
          setLoading(false);
        }
      }
    },
    [
      activeCursor,
      pagination.cursorIndex,
      t,
    ],
  );

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handlePreviousPage =
    useCallback((): void => {
      if (loading) {
        return;
      }

      setPagination((current) => {
        if (
          current.cursorIndex === 0
        ) {
          return current;
        }

        return {
          ...current,
          cursorIndex:
            current.cursorIndex - 1,
        };
      });
    }, [loading]);

  const handleNextPage =
    useCallback((): void => {
      const nextCursor =
        pageInfo.nextCursor;

      if (
        loading ||
        !pageInfo.hasNextPage ||
        !nextCursor
      ) {
        return;
      }

      setPagination((current) => {
        const currentCursor =
          current.cursors[
            current.cursorIndex
          ] ?? null;

        if (
          nextCursor ===
          currentCursor
        ) {
          return current;
        }

        const nextIndex =
          current.cursorIndex + 1;

        return {
          cursors: [
            ...current.cursors.slice(
              0,
              nextIndex,
            ),
            nextCursor,
          ],
          cursorIndex: nextIndex,
        };
      });
    }, [
      loading,
      pageInfo.hasNextPage,
      pageInfo.nextCursor,
    ]);

  const handleRetry =
    useCallback((): void => {
      void fetchData();
    }, [fetchData]);

  const unavailableLabel = t(
    "common:unavailable",
    {
      defaultValue: "—",
    },
  );

  const untitledLabel = t(
    "historyImportUntitled",
    {
      defaultValue: "Untitled import",
    },
  );

  const rowsLabel = t(
    "historyImportRowsLabel",
    {
      defaultValue: "rows",
    },
  );

  const hasPagination =
    pageInfo.hasNextPage ||
    pageInfo.hasPreviousPage;

  return (
    <s-page
      heading={t(
        "historyImportTitle",
        {
          defaultValue:
            "Import history",
        },
      )}
      subheading={t(
        "historyImportSubtitle",
        {
          defaultValue:
            "View your product import history and processing results.",
        },
      )}
      inlineSize="large"
    >
      <s-stack gap="base">
        {loadError ? (
          <s-banner
            heading={t(
              "historyImportLoadError",
              {
                defaultValue:
                  "Import history could not be loaded",
              },
            )}
            tone="critical"
          >
            <s-paragraph>
              {loadError}
            </s-paragraph>

            <s-button
              slot="primary-action"
              onClick={handleRetry}
            >
              {t("common:retry", {
                defaultValue: "Retry",
              })}
            </s-button>
          </s-banner>
        ) : null}

        <s-section>
          {!loadError &&
          !loading &&
          items.length === 0 ? (
            <s-grid
              gap="base"
              justifyItems="center"
              paddingBlock="large-400"
            >
              <s-stack
                gap="base"
                alignItems="center"
              >
                <s-heading>
                  {t(
                    "historyImportEmptyTitle",
                    {
                      defaultValue:
                        "No import history found",
                    },
                  )}
                </s-heading>

                <s-paragraph color="subdued">
                  {t(
                    "historyImportEmptyText",
                    {
                      defaultValue:
                        "When you import CSV files, they will appear here.",
                    },
                  )}
                </s-paragraph>
              </s-stack>
            </s-grid>
          ) : (
            <s-table
              variant="auto"
              loading={loading}
              paginate={hasPagination}
              hasPreviousPage={
                !loading &&
                pageInfo.hasPreviousPage
              }
              hasNextPage={
                !loading &&
                pageInfo.hasNextPage
              }
              onPreviousPage={
                loading
                  ? undefined
                  : handlePreviousPage
              }
              onNextPage={
                loading
                  ? undefined
                  : handleNextPage
              }
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">
                  {t(
                    "historyImportFileName",
                    {
                      defaultValue:
                        "File name",
                    },
                  )}
                </s-table-header>

                <s-table-header listSlot="inline">
                  {t(
                    "historyImportStatus",
                    {
                      defaultValue:
                        "Status",
                    },
                  )}
                </s-table-header>

                <s-table-header
                  listSlot="labeled"
                  format="numeric"
                >
                  {t(
                    "historyImportTotalRows",
                    {
                      defaultValue:
                        "Total rows",
                    },
                  )}
                </s-table-header>

                <s-table-header listSlot="labeled">
                  {t(
                    "historyImportDate",
                    {
                      defaultValue:
                        "Date",
                    },
                  )}
                </s-table-header>
              </s-table-header-row>

              <s-table-body>
                {items.map((item) => {
                  const rowId =
                    getImportRowId(item);

                  if (!rowId) {
                    return null;
                  }

                  const filename =
                    typeof item.filename ===
                      "string" &&
                    item.filename.trim()
                      ? item.filename.trim()
                      : untitledLabel;

                  const statusTone =
                    getStatusTone(
                      item.status,
                    );

                  const statusLabel =
                    getStatusLabel(
                      item.status,
                      t,
                    );

                  const totalRows =
                    normalizeRowCount(
                      item.totalRows,
                    );

                  const formattedDate =
                    formatImportDate(
                      item.createdAt,
                      dateTimeFormatter,
                      unavailableLabel,
                    );

                  return (
                    <s-table-row key={rowId}>
                      <s-table-cell>
                        <s-text type="strong">
                          {filename}
                        </s-text>
                      </s-table-cell>

                      <s-table-cell>
                        <s-badge
                          {...(statusTone
                            ? {
                                tone: statusTone,
                              }
                            : {})}
                        >
                          {statusLabel}
                        </s-badge>
                      </s-table-cell>

                      <s-table-cell>
                        {totalRows === null ? (
                          <s-text>
                            {unavailableLabel}
                          </s-text>
                        ) : (
                          <s-stack
                            direction="inline"
                            gap="small-200"
                            alignItems="center"
                          >
                            <s-text>
                              {numberFormatter.format(
                                totalRows,
                              )}
                            </s-text>

                            <s-text color="subdued">
                              {rowsLabel}
                            </s-text>
                          </s-stack>
                        )}
                      </s-table-cell>

                      <s-table-cell>
                        <s-text color="subdued">
                          {formattedDate}
                        </s-text>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          )}
        </s-section>
      </s-stack>
    </s-page>
  );
}
