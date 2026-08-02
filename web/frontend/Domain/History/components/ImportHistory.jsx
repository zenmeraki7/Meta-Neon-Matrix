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

const INITIAL_PAGE_INFO = Object.freeze({
  hasNextPage: false,
  hasPreviousPage: false,
  nextCursor: null,
});

function getImportRowId(item) {
  if (item?.id == null) {
    return null;
  }

  const id = String(item.id).trim();

  return id || null;
}

function normalizeStatus(status) {
  return String(status || "unknown")
    .trim()
    .toLowerCase();
}

function getStatusTone(status) {
  switch (normalizeStatus(status)) {
    case "completed":
    case "success":
    case "processed":
      return "success";

    case "failed":
    case "error":
    case "cancelled":
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

    default:
      return "neutral";
  }
}

function normalizeRowCount(value) {
  const count = Number(value);

  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }

  return count;
}

function formatImportDate(value, formatter) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return formatter.format(date);
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

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] =
    useState(null);

  const [pagination, setPagination] =
    useState(() => ({
      cursors: [null],
      cursorIndex: 0,
    }));

  const [pageInfo, setPageInfo] = useState(
    INITIAL_PAGE_INFO,
  );

  const requestSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const requestAbortRef = useRef(null);

  const activeCursor =
    pagination.cursors[
    pagination.cursorIndex
    ] ?? null;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      requestAbortRef.current?.abort();
    };
  }, []);

  const fetchData = useCallback(async () => {
    requestAbortRef.current?.abort();

    const controller = new AbortController();
    requestAbortRef.current = controller;

    const requestSequence =
      requestSequenceRef.current + 1;

    requestSequenceRef.current =
      requestSequence;

    setLoading(true);
    setLoadError(null);

    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
      });

      if (activeCursor) {
        params.set("cursor", activeCursor);
      }

      const result = await protectedApiGet(
        `/api/history/get-shop-importhistory?${params.toString()}`,
        {
          signal: controller.signal,
        },
      );

      if (
        !mountedRef.current ||
        requestSequence !==
        requestSequenceRef.current
      ) {
        return;
      }

      if (!result?.success) {
        throw new Error(
          result?.message ||
          "IMPORT_HISTORY_LOAD_FAILED",
        );
      }

      const payload =
        result.items ?? result.data ?? [];

      const responsePageInfo =
        result.pageInfo ??
        result.meta?.pageInfo ??
        {};

      setItems(
        Array.isArray(payload) ? payload : [],
      );

      setPageInfo({
        hasNextPage: Boolean(
          responsePageInfo.hasNextPage,
        ),
        hasPreviousPage:
          pagination.cursorIndex > 0,
        nextCursor:
          responsePageInfo.nextCursor ??
          responsePageInfo.endCursor ??
          null,
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        error?.name === "AbortError"
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

      setItems([]);

      setPageInfo({
        ...INITIAL_PAGE_INFO,
        hasPreviousPage:
          pagination.cursorIndex > 0,
      });

      setLoadError(
        toSafeErrorMessage(
          t,
          error,
          "common.errors.generic",
        ),
      );
    } finally {
      if (
        requestAbortRef.current === controller
      ) {
        requestAbortRef.current = null;
      }

      if (
        mountedRef.current &&
        requestSequence ===
        requestSequenceRef.current
      ) {
        setLoading(false);
      }
    }
  }, [
    activeCursor,
    pagination.cursorIndex,
    t,
  ]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handlePreviousPage = useCallback(() => {
    setPagination((current) => {
      if (current.cursorIndex === 0) {
        return current;
      }

      return {
        ...current,
        cursorIndex: current.cursorIndex - 1,
      };
    });
  }, []);

  const handleNextPage = useCallback(() => {
    const nextCursor = pageInfo.nextCursor;

    if (!pageInfo.hasNextPage || !nextCursor) {
      return;
    }

    setPagination((current) => {
      const currentCursor =
        current.cursors[current.cursorIndex] ?? null;

      if (nextCursor === currentCursor) {
        return current;
      }

      const nextIndex = current.cursorIndex + 1;

      return {
        cursors: [
          ...current.cursors.slice(0, nextIndex),
          nextCursor,
        ],
        cursorIndex: nextIndex,
      };
    });
  }, [
    pageInfo.hasNextPage,
    pageInfo.nextCursor,
  ]);

  return (
    <s-page
      heading={t("historyImportTitle", {
        defaultValue: "Import History",
      })}
      subheading={t(
        "historyImportSubtitle",
        {
          defaultValue:
            "View and manage your product import history",
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
              onClick={() =>
                void fetchData()
              }
            >
              {t("common:retry", {
                defaultValue: "Retry",
              })}
            </s-button>
          </s-banner>
        ) : null}

        <s-section
          accessibilityLabel={t(
            "historyImportTitle",
            {
              defaultValue:
                "Import History",
            },
          )}
        >
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
              paginate
              hasPreviousPage={
                pageInfo.hasPreviousPage
              }
              hasNextPage={
                pageInfo.hasNextPage
              }
              onPreviousPage={
                handlePreviousPage
              }
              onNextPage={handleNextPage}
            >
              <s-table-header-row>
                <s-table-header listSlot="primary">
                  {t(
                    "historyImportFileName",
                    {
                      defaultValue:
                        "File Name",
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
                        "Total Rows",
                    },
                  )}
                </s-table-header>

                <s-table-header listSlot="labeled">
                  {t(
                    "historyImportDate",
                    {
                      defaultValue: "Date",
                    },
                  )}
                </s-table-header>
              </s-table-header-row>

              <s-table-body>
                {items.map((item) => {
                  const rowId = getImportRowId(item);

                  if (!rowId) {
                    return null;
                  }

                  const filename =
                    item?.filename ||
                    t("historyImportUntitled", {
                      defaultValue:
                        "Untitled import",
                    });

                  const statusLabel = String(
                    item?.status ||
                    t(
                      "historyImportUnknownStatus",
                      {
                        defaultValue: "Unknown",
                      },
                    ),
                  );

                  const totalRows = normalizeRowCount(
                    item?.totalRows,
                  );

                  const formattedDate =
                    formatImportDate(
                      item?.createdAt,
                      dateTimeFormatter,
                    );

                  return (
                    <s-table-row key={rowId}>
                      <s-table-cell>
                        <s-stack gap="small-200">
                          <s-text type="strong">
                            {filename}
                          </s-text>

                          <s-text color="subdued">
                            {item?.id != null
                              ? String(item.id)
                              : "-"}
                          </s-text>
                        </s-stack>
                      </s-table-cell>

                      <s-table-cell>
                        <s-badge
                          tone={getStatusTone(
                            item?.status,
                          )}
                        >
                          {statusLabel}
                        </s-badge>
                      </s-table-cell>

                      <s-table-cell>
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
                            {t(
                              "historyImportRowsLabel",
                              {
                                defaultValue: "rows",
                              },
                            )}
                          </s-text>
                        </s-stack>
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