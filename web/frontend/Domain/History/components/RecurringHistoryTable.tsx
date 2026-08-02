import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RecurringEditDto } from "../../../../../shared/recurringEdit";

const RecurringEditViewModal = lazy(
  () => import("./RecurringEditView"),
);
import {
  protectedApiDelete,
  protectedApiGet,
} from "../../../api/protectedApiClient";
import { toSafeErrorMessage } from "../../../utils/frontendError";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import useDebouncedValue from "../../../hooks/useDebouncedValue";
import { useRecurringHistoryQuery } from "../hooks/useRecurringHistoryQuery";

const DELETE_MODAL_ID =
  "delete-recurring-edit-modal";

const SORT_DIRECTION = {
  ASCENDING: "asc",
  DESCENDING: "desc",
} as const;

type SortDirection =
  (typeof SORT_DIRECTION)[keyof typeof SORT_DIRECTION];

const STATUS_OPTIONS = [
  {
    labelKey: "recurringStatusActive",
    value: "active",
    defaultValue: "Active",
  },
  {
    labelKey: "recurringStatusInactive",
    value: "inactive",
    defaultValue: "Inactive",
  },
  {
    labelKey: "recurringStatusPaused",
    value: "paused",
    defaultValue: "Paused",
  },
  {
    labelKey: "recurringStatusCompleted",
    value: "completed",
    defaultValue: "Completed",
  },
  {
    labelKey: "recurringStatusFailed",
    value: "failed",
    defaultValue: "Failed",
  },
  {
    labelKey: "recurringStatusExpired",
    value: "expired",
    defaultValue: "Expired",
  },
] as const;

type RecurringStatusFilter =
  (typeof STATUS_OPTIONS)[number]["value"];

const FREQUENCY_OPTIONS = [
  {
    labelKey: "recurringFrequencyHourly",
    value: "hourly",
    defaultValue: "Hourly",
  },
  {
    labelKey: "recurringFrequencyEvery2Hours",
    value: "every 2 hours",
    defaultValue: "Every 2 hours",
  },
  {
    labelKey: "recurringFrequencyDaily",
    value: "daily",
    defaultValue: "Daily",
  },
  {
    labelKey: "recurringFrequencyWeekly",
    value: "weekly",
    defaultValue: "Weekly",
  },
  {
    labelKey: "recurringFrequencyMonthly",
    value: "monthly",
    defaultValue: "Monthly",
  },
] as const;

type RecurringFrequencyFilter =
  (typeof FREQUENCY_OPTIONS)[number]["value"];

type BadgeTone =
  | "success"
  | "critical"
  | "warning"
  | "info"
  | "neutral";

export interface RecurringHistoryQuery {
  limit: number;
  search: string;
  status: RecurringStatusFilter | "";
  frequency: RecurringFrequencyFilter | "";
  sortKey: string;
  sortDirection: SortDirection;
}

export interface RecurringStatusSummary {
  labelKey?: string | null;
  defaultLabel?: string | null;
  [key: string]: unknown;
}

export interface RecurringFrequencySummary {
  labelKey?: string | null;
  defaultLabel?: string | null;
  [key: string]: unknown;
}

export interface RecurringHistoryItem {
  id?: string | number | null;
  title?: string | null;
  status?: string | null;
  frequency?: string | null;
  successfulRuns?: number | string | null;
  totalRuns?: number | string | null;
  createdAt?: string | number | Date | null;
  statusSummary?: RecurringStatusSummary | null;
  frequencySummary?: RecurringFrequencySummary | null;
  [key: string]: unknown;
}

interface RecurringHistoryPageInfoSource {
  hasNextPage?: unknown;
  nextCursor?: unknown;
  endCursor?: unknown;
}

interface RecurringHistoryResponse {
  items?: unknown;
  data?: unknown;
  pageInfo?: RecurringHistoryPageInfoSource | null;
  meta?: {
    pageInfo?: RecurringHistoryPageInfoSource | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface NormalizedPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor: string | null;
}

interface RecurringHistoryTableProps {
  onRefresh?: () => void | Promise<void>;
  emptyStateMessage?: string;
}

interface RecurringRowActionsProps {
  item: RecurringHistoryItem;
  onView: (id: string) => void;
  onDelete: (item: RecurringHistoryItem) => void;
  viewLabel: string;
  deleteLabel: string;
}

interface RecurringHistoryRowProps {
  item: RecurringHistoryItem;
  dateTimeFormatter: Intl.DateTimeFormat;
  numberFormatter: Intl.NumberFormat;
  onView: (id: string) => void;
  onDelete: (item: RecurringHistoryItem) => void;
  viewLabel: string;
  deleteLabel: string;
  t: TFunction;
}

type ShopifyModalElement =
  HTMLElementTagNameMap["s-modal"];

type ShopifySelectElement =
  HTMLElementTagNameMap["s-select"];

type ShopifyInputElement =
  HTMLElementTagNameMap["s-text-field"];

type ValueEvent = FormEvent<ShopifySelectElement | ShopifyInputElement>;

const DEFAULT_QUERY: Readonly<RecurringHistoryQuery> =
  Object.freeze({
    limit: 20,
    search: "",
    status: "",
    frequency: "",
    sortKey: "createdAt",
    sortDirection: SORT_DIRECTION.DESCENDING,
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

function isRecurringHistoryItem(
  value: unknown,
): value is RecurringHistoryItem {
  return isRecord(value);
}

function normalizeStatus(
  value: unknown,
): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function normalizeCount(
  value: unknown,
): number {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return 0;
  }

  const count = Number(value);

  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }

  return Math.trunc(count);
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

function normalizeDisplayText(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();

  return normalized || fallback;
}

function getRecurringItemId(
  item: RecurringHistoryItem | null | undefined,
): string | null {
  if (
    item?.id === undefined ||
    item.id === null
  ) {
    return null;
  }

  const id = String(item.id).trim();

  return id || null;
}

function getStatusTone(
  status: unknown,
): BadgeTone {
  switch (normalizeStatus(status)) {
    case "active":
    case "completed":
    case "success":
      return "success";

    case "failed":
    case "error":
    case "cancelled":
      return "critical";

    case "inactive":
    case "paused":
    case "expired":
      return "warning";

    case "running":
    case "processing":
    case "queued":
      return "info";

    default:
      return "neutral";
  }
}

function formatDate(
  value: string | number | Date | null | undefined,
  formatter: Intl.DateTimeFormat,
  unavailableLabel: string,
): string {
  if (!value) {
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
    error instanceof Error &&
    error.name === "AbortError"
  );
}

function normalizeHistoryItems(
  response: RecurringHistoryResponse | undefined,
): RecurringHistoryItem[] {
  const result =
    response?.items ??
    response?.data ??
    [];

  if (!Array.isArray(result)) {
    return [];
  }

  return result.filter(isRecurringHistoryItem);
}

function isRecurringStatusFilter(
  value: string,
): value is RecurringStatusFilter {
  return STATUS_OPTIONS.some(
    (option) => option.value === value,
  );
}

function isRecurringFrequencyFilter(
  value: string,
): value is RecurringFrequencyFilter {
  return FREQUENCY_OPTIONS.some(
    (option) => option.value === value,
  );
}

const RecurringRowActions = memo(
  function RecurringRowActions({
    item,
    onView,
    onDelete,
    viewLabel,
    deleteLabel,
  }: RecurringRowActionsProps) {
    const id = getRecurringItemId(item);

    const handleView = useCallback((): void => {
      if (id) {
        onView(id);
      }
    }, [id, onView]);

    const handleDelete = useCallback((): void => {
      if (id) {
        onDelete(item);
      }
    }, [id, item, onDelete]);

    return (
      <s-button-group gap="small">
        <s-button
          variant="secondary"
          disabled={!id}
          onClick={handleView}
        >
          {viewLabel}
        </s-button>

        <s-button
          variant="secondary"
          tone="critical"
          disabled={!id}
          onClick={handleDelete}
        >
          {deleteLabel}
        </s-button>
      </s-button-group>
    );
  },
);

const RecurringHistoryRow = memo(
  function RecurringHistoryRow({
    item,
    dateTimeFormatter,
    numberFormatter,
    onView,
    onDelete,
    viewLabel,
    deleteLabel,
    t,
  }: RecurringHistoryRowProps) {
    const id = getRecurringItemId(item);

    if (!id) {
      return null;
    }

    const unavailableLabel = t(
      "common:unavailable",
      {
        defaultValue: "—",
      },
    );

    const status = normalizeStatus(
      item.status,
    );

    const statusLabelKey =
      normalizeDisplayText(
        item.statusSummary?.labelKey,
        `statusRecurring.${status || "unknown"}`,
      );

    const statusDefaultLabel =
      normalizeDisplayText(
        item.statusSummary?.defaultLabel,
        normalizeDisplayText(
          item.status,
          t("unknown", {
            defaultValue: "Unknown",
          }),
        ),
      );

    const statusLabel = t(
      statusLabelKey,
      {
        defaultValue:
          statusDefaultLabel,
      },
    );

    const frequency = normalizeStatus(
      item.frequency,
    );

    const frequencyLabelKey =
      normalizeDisplayText(
        item.frequencySummary?.labelKey,
        `frequencyRecurring.${frequency || "unknown"}`,
      );

    const frequencyDefaultLabel =
      normalizeDisplayText(
        item.frequencySummary?.defaultLabel,
        normalizeDisplayText(
          item.frequency,
          unavailableLabel,
        ),
      );

    const frequencyLabel = t(
      frequencyLabelKey,
      {
        defaultValue:
          frequencyDefaultLabel,
      },
    );

    const successfulRuns =
      normalizeCount(
        item.successfulRuns,
      );

    const totalRuns =
      normalizeCount(item.totalRuns);

    const title = normalizeDisplayText(
      item.title,
      t("common:recurringUntitled", {
        defaultValue: "Untitled",
      }),
    );

    return (
      <s-table-row>
        <s-table-cell>
          <s-text type="strong">
            {title}
          </s-text>
        </s-table-cell>

        <s-table-cell>
          <s-badge
            tone={getStatusTone(status)}
          >
            {statusLabel}
          </s-badge>
        </s-table-cell>

        <s-table-cell>
          <s-badge tone="info">
            {frequencyLabel}
          </s-badge>
        </s-table-cell>

        <s-table-cell>
          <s-text>
            {numberFormatter.format(
              successfulRuns,
            )}{" "}
            /{" "}
            {numberFormatter.format(
              totalRuns,
            )}
          </s-text>
        </s-table-cell>

        <s-table-cell>
          <s-text color="subdued">
            {formatDate(
              item.createdAt,
              dateTimeFormatter,
              unavailableLabel,
            )}
          </s-text>
        </s-table-cell>

        <s-table-cell>
          <RecurringRowActions
            item={item}
            onView={onView}
            onDelete={onDelete}
            viewLabel={viewLabel}
            deleteLabel={deleteLabel}
          />
        </s-table-cell>
      </s-table-row>
    );
  },
);

const RecurringHistoryTable = memo(
  function RecurringHistoryTable({
    onRefresh,
    emptyStateMessage,
  }: RecurringHistoryTableProps) {
    const { t, i18n } = useTranslation([
      "history",
      "common",
    ]);

    const queryClient =
      useQueryClient();

    const {
      dateTimeFormatter,
      numberFormatter,
    } = useLocaleFormatters();

    const deleteModalRef =
      useRef<ShopifyModalElement | null>(null);

    const detailsRequestIdRef =
      useRef<number>(0);

    const detailsAbortRef =
      useRef<AbortController | null>(null);

    const [detailsOpen, setDetailsOpen] =
      useState<boolean>(false);

    const [
      historyItem,
      setHistoryItem,
    ] =
      useState<RecurringEditDto | null>(
        null,
      );

    const [
      isLoadingDetails,
      setIsLoadingDetails,
    ] = useState<boolean>(false);

    const [
      detailsError,
      setDetailsError,
    ] = useState<string | null>(null);

    const [
      deleteRecurringItem,
      setDeleteRecurringItem,
    ] =
      useState<RecurringHistoryItem | null>(
        null,
      );

    const [
      deleteLoading,
      setDeleteLoading,
    ] = useState<boolean>(false);

    const [query, setQuery] =
      useState<RecurringHistoryQuery>(() => ({
        ...DEFAULT_QUERY,
      }));

    const [
      cursorStack,
      setCursorStack,
    ] = useState<Array<string | null>>([
      null,
    ]);

    const [
      cursorIndex,
      setCursorIndex,
    ] = useState<number>(0);

    const [
      searchDraft,
      setSearchDraft,
    ] = useState<string>(
      DEFAULT_QUERY.search,
    );

    const debouncedSearchDraft =
      useDebouncedValue(
        searchDraft,
        400,
      );

    const activeCursor =
      cursorStack[cursorIndex] ??
      null;

    const language =
      i18n.resolvedLanguage ||
      i18n.language ||
      "en";

    const recurringQuery =
      useRecurringHistoryQuery({
        query,
        cursor: activeCursor,
        lang: language,
      });

    const response =
      recurringQuery.data as
      | RecurringHistoryResponse
      | undefined;

    const items = useMemo(
      () =>
        normalizeHistoryItems(
          response,
        ),
      [response],
    );

    const pageInfoSource =
      response?.pageInfo ??
      response?.meta?.pageInfo ??
      {};

    const pageInfo =
      useMemo<NormalizedPageInfo>(
        () => ({
          hasNextPage: Boolean(
            pageInfoSource.hasNextPage,
          ),
          hasPreviousPage:
            cursorIndex > 0,
          nextCursor: normalizeCursor(
            pageInfoSource.nextCursor ??
            pageInfoSource.endCursor,
          ),
        }),
        [
          cursorIndex,
          pageInfoSource.endCursor,
          pageInfoSource.hasNextPage,
          pageInfoSource.nextCursor,
        ],
      );

    const queryBusy =
      recurringQuery.isLoading ||
      recurringQuery.isFetching;

    const resetPagination =
      useCallback((): void => {
        setCursorStack((current) => {
          if (
            current.length === 1 &&
            current[0] === null
          ) {
            return current;
          }

          return [null];
        });

        setCursorIndex((current) =>
          current === 0 ? current : 0,
        );
      }, []);

    useEffect(() => {
      if (
        query.search ===
        debouncedSearchDraft
      ) {
        return;
      }

      resetPagination();

      setQuery((current) => ({
        ...current,
        search:
          debouncedSearchDraft,
      }));
    }, [
      debouncedSearchDraft,
      query.search,
      resetPagination,
    ]);

    useEffect(() => {
      resetPagination();
    }, [language, resetPagination]);

    useEffect(
      () => () => {
        detailsRequestIdRef.current += 1;
        detailsAbortRef.current?.abort();
        detailsAbortRef.current = null;
      },
      [],
    );

    const handleSearchInput =
      useCallback(
        (event: ValueEvent): void => {
          setSearchDraft(
            event.currentTarget.value,
          );
        },
        [],
      );

    const handleStatusChange =
      useCallback(
        (event: ValueEvent): void => {
          const value =
            event.currentTarget.value;

          if (
            value &&
            !isRecurringStatusFilter(
              value,
            )
          ) {
            return;
          }

          resetPagination();

          const nextStatus: RecurringStatusFilter | "" =
            isRecurringStatusFilter(value) ? value : "";

          setQuery((current) => {
            if (
              current.status ===
              nextStatus
            ) {
              return current;
            }

            return {
              ...current,
              status: nextStatus,
            };
          });
        },
        [resetPagination],
      );

    const handleFrequencyChange =
      useCallback(
        (event: ValueEvent): void => {
          const value =
            event.currentTarget.value;

          if (
            value &&
            !isRecurringFrequencyFilter(
              value,
            )
          ) {
            return;
          }

          resetPagination();

          const nextFrequency: RecurringFrequencyFilter | "" =
            isRecurringFrequencyFilter(value) ? value : "";

          setQuery((current) => {
            if (
              current.frequency ===
              nextFrequency
            ) {
              return current;
            }

            return {
              ...current,
              frequency: nextFrequency,
            };
          });
        },
        [resetPagination],
      );

    const handleClearFilters =
      useCallback((): void => {
        setSearchDraft("");
        resetPagination();

        setQuery((current) => {
          if (
            current.search === "" &&
            current.status === "" &&
            current.frequency === ""
          ) {
            return current;
          }

          return {
            ...current,
            search: "",
            status: "",
            frequency: "",
          };
        });
      }, [resetPagination]);

    const onViewDetails =
      useCallback(
        async (id: string): Promise<void> => {
          const normalizedId =
            id.trim();

          if (!normalizedId) {
            return;
          }

          detailsAbortRef.current?.abort();

          const controller =
            new AbortController();

          detailsAbortRef.current =
            controller;

          const requestId =
            detailsRequestIdRef.current +
            1;

          detailsRequestIdRef.current =
            requestId;

          setDetailsOpen(true);
          setHistoryItem(null);
          setDetailsError(null);
          setIsLoadingDetails(true);

          try {
            const params =
              new URLSearchParams({
                lang: language,
              });

            const result: unknown =
              await protectedApiGet(
                `/api/products/recurring/detail/${encodeURIComponent(
                  normalizedId,
                )}?${params.toString()}`,
                {
                  signal:
                    controller.signal,
                },
              );

            if (
              controller.signal.aborted ||
              requestId !==
              detailsRequestIdRef.current
            ) {
              return;
            }

            const detail =
              isRecord(result) &&
                isRecord(result.data)
                ? result.data
                : result;

            setHistoryItem(
              isRecord(detail)
                ? (detail as unknown as RecurringEditDto)
                : null,
            );
          } catch (
          requestError: unknown
          ) {
            if (
              controller.signal.aborted ||
              isAbortError(
                requestError,
              ) ||
              requestId !==
              detailsRequestIdRef.current
            ) {
              return;
            }

            setDetailsError(
              toSafeErrorMessage(
                t,
                requestError,
                "common.errors.generic",
              ),
            );
          } finally {
            if (
              detailsAbortRef.current ===
              controller
            ) {
              detailsAbortRef.current =
                null;
            }

            if (
              !controller.signal.aborted &&
              requestId ===
              detailsRequestIdRef.current
            ) {
              setIsLoadingDetails(
                false,
              );
            }
          }
        },
        [language, t],
      );

    const closeDetailsModal =
      useCallback((): void => {
        detailsRequestIdRef.current += 1;
        detailsAbortRef.current?.abort();
        detailsAbortRef.current = null;

        setDetailsOpen(false);
        setHistoryItem(null);
        setDetailsError(null);
        setIsLoadingDetails(false);
      }, []);

    const openDeleteModal =
      useCallback(
        (
          item: RecurringHistoryItem,
        ): void => {
          const id =
            getRecurringItemId(item);

          if (!id) {
            return;
          }

          setDetailsError(null);
          setDeleteRecurringItem(
            item,
          );

          deleteModalRef.current?.showOverlay();
        },
        [],
      );

    const closeDeleteModal =
      useCallback((): void => {
        if (deleteLoading) {
          return;
        }

        deleteModalRef.current?.hideOverlay();
      }, [deleteLoading]);

    const handleDeleteModalHidden =
      useCallback((): void => {
        if (!deleteLoading) {
          setDeleteRecurringItem(null);
        }
      }, [deleteLoading]);

    const handleDeleteRecurring =
      useCallback(
        async (): Promise<void> => {
          const id =
            getRecurringItemId(
              deleteRecurringItem,
            );

          if (
            !id ||
            deleteLoading
          ) {
            return;
          }

          setDeleteLoading(true);
          setDetailsError(null);

          try {
            await protectedApiDelete(
              `/api/products/delete-recurring-edit/${encodeURIComponent(
                id,
              )}`,
              {
                idempotent: true,
              },
            );

            await queryClient.invalidateQueries(
              {
                queryKey: [
                  "recurring-history-list",
                ],
              },
            );

            await onRefresh?.();

            deleteModalRef.current?.hideOverlay();
          } catch (
          deleteError: unknown
          ) {
            setDetailsError(
              toSafeErrorMessage(
                t,
                deleteError,
                "common.errors.generic",
              ),
            );
          } finally {
            setDeleteLoading(false);
          }
        },
        [
          deleteLoading,
          deleteRecurringItem,
          onRefresh,
          queryClient,
          t,
        ],
      );

    const handleNextPage =
      useCallback((): void => {
        const nextCursor =
          pageInfo.nextCursor;

        if (
          queryBusy ||
          !pageInfo.hasNextPage ||
          !nextCursor
        ) {
          return;
        }

        setCursorStack(
          (current) => {
            const currentCursor =
              current[
              cursorIndex
              ] ?? null;

            if (
              currentCursor ===
              nextCursor
            ) {
              return current;
            }

            return [
              ...current.slice(
                0,
                cursorIndex + 1,
              ),
              nextCursor,
            ];
          },
        );

        setCursorIndex(
          (current) =>
            current + 1,
        );
      }, [
        cursorIndex,
        pageInfo.hasNextPage,
        pageInfo.nextCursor,
        queryBusy,
      ]);

    const handlePreviousPage =
      useCallback((): void => {
        if (queryBusy) {
          return;
        }

        setCursorIndex((current) =>
          Math.max(
            0,
            current - 1,
          ),
        );
      }, [queryBusy]);

    const handleRetry =
      useCallback((): void => {
        void recurringQuery.refetch();
      }, [recurringQuery]);

    const viewLabel = t("view", {
      defaultValue: "View",
    });

    const deleteLabel = t("delete", {
      defaultValue: "Delete",
    });

    const queryError =
      recurringQuery.error
        ? toSafeErrorMessage(
          t,
          recurringQuery.error,
          "common.errors.generic",
        )
        : null;

    const hasActiveFilters =
      Boolean(searchDraft.trim()) ||
      Boolean(query.status) ||
      Boolean(query.frequency);

    const hasPagination =
      pageInfo.hasNextPage ||
      pageInfo.hasPreviousPage;

    const deleteTitle =
      normalizeDisplayText(
        deleteRecurringItem?.title,
        "",
      );

    return (
      <>
        <s-section
          padding="none"
          accessibilityLabel={t(
            "recurringHistoryLabel",
            {
              defaultValue:
                "Recurring edit history",
            },
          )}
        >
          <s-stack gap="none">
            <s-box
              padding="base"
              borderBlockEnd="base"
            >
              <s-stack gap="base">
                <s-grid
                  gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 220px), 1fr))"
                  gap="base"
                  alignItems="end"
                >
                  <s-search-field
                    label={t(
                      "recurringSearchLabel",
                      {
                        defaultValue:
                          "Search recurring edits",
                      },
                    )}
                    labelAccessibilityVisibility="exclusive"
                    name="recurring-search"
                    placeholder={t(
                      "recurringSearchPlaceholder",
                      {
                        defaultValue:
                          "Search recurring edits",
                      },
                    )}
                    value={searchDraft}
                    autocomplete="off"
                    onInput={
                      handleSearchInput
                    }
                  />

                  <s-select
                    label={t(
                      "recurringFilterStatus",
                      {
                        defaultValue:
                          "Status",
                      },
                    )}
                    name="recurring-status"
                    value={query.status}
                    onChange={
                      handleStatusChange
                    }
                  >
                    <s-option value="">
                      {t(
                        "recurringFilterAllStatuses",
                        {
                          defaultValue:
                            "All statuses",
                        },
                      )}
                    </s-option>

                    {STATUS_OPTIONS.map(
                      (option) => (
                        <s-option
                          key={option.value}
                          value={
                            option.value
                          }
                        >
                          {t(
                            option.labelKey,
                            {
                              defaultValue:
                                option.defaultValue,
                            },
                          )}
                        </s-option>
                      ),
                    )}
                  </s-select>

                  <s-select
                    label={t(
                      "recurringFilterFrequency",
                      {
                        defaultValue:
                          "Frequency",
                      },
                    )}
                    name="recurring-frequency"
                    value={
                      query.frequency
                    }
                    onChange={
                      handleFrequencyChange
                    }
                  >
                    <s-option value="">
                      {t(
                        "recurringFilterAllFrequencies",
                        {
                          defaultValue:
                            "All frequencies",
                        },
                      )}
                    </s-option>

                    {FREQUENCY_OPTIONS.map(
                      (option) => (
                        <s-option
                          key={option.value}
                          value={
                            option.value
                          }
                        >
                          {t(
                            option.labelKey,
                            {
                              defaultValue:
                                option.defaultValue,
                            },
                          )}
                        </s-option>
                      ),
                    )}
                  </s-select>

                  <s-button
                    variant="secondary"
                    disabled={
                      !hasActiveFilters
                    }
                    onClick={
                      handleClearFilters
                    }
                  >
                    {t(
                      "recurringClearFilters",
                      {
                        defaultValue:
                          "Clear filters",
                      },
                    )}
                  </s-button>
                </s-grid>

                {query.status ||
                  query.frequency ? (
                  <s-stack
                    direction="inline"
                    gap="small"
                    alignItems="center"
                  >
                    {query.status ? (
                      <s-badge tone="info">
                        {t(
                          "recurringFilterStatusLabel",
                          {
                            value:
                              query.status,
                            defaultValue:
                              `Status: ${query.status}`,
                          },
                        )}
                      </s-badge>
                    ) : null}

                    {query.frequency ? (
                      <s-badge tone="info">
                        {t(
                          "recurringFilterFrequencyLabel",
                          {
                            value:
                              query.frequency,
                            defaultValue:
                              `Frequency: ${query.frequency}`,
                          },
                        )}
                      </s-badge>
                    ) : null}
                  </s-stack>
                ) : null}
              </s-stack>
            </s-box>

            {queryError ? (
              <s-box padding="base">
                <s-banner
                  heading={t(
                    "recurringLoadError",
                    {
                      defaultValue:
                        "Recurring edits could not be loaded",
                    },
                  )}
                  tone="critical"
                >
                  <s-paragraph>
                    {queryError}
                  </s-paragraph>

                  <s-button
                    slot="primary-action"
                    onClick={handleRetry}
                  >
                    {t(
                      "common:retry",
                      {
                        defaultValue:
                          "Retry",
                      },
                    )}
                  </s-button>
                </s-banner>
              </s-box>
            ) : null}

            {!queryError &&
              !queryBusy &&
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
                      "historyEmptyStateTitle",
                      {
                        defaultValue:
                          "No recurring edits found",
                      },
                    )}
                  </s-heading>

                  <s-paragraph color="subdued">
                    {emptyStateMessage ||
                      t(
                        "recurringEmptyStateMessage",
                        {
                          defaultValue:
                            "No recurring edits found.",
                        },
                      )}
                  </s-paragraph>
                </s-stack>
              </s-grid>
            ) : !queryError ? (
              <s-table
                variant="auto"
                loading={queryBusy}
                paginate={hasPagination}
                hasNextPage={
                  !queryBusy &&
                  pageInfo.hasNextPage
                }
                hasPreviousPage={
                  !queryBusy &&
                  pageInfo.hasPreviousPage
                }
                onNextPage={
                  queryBusy
                    ? undefined
                    : handleNextPage
                }
                onPreviousPage={
                  queryBusy
                    ? undefined
                    : handlePreviousPage
                }
              >
                <s-table-header-row>
                  <s-table-header listSlot="primary">
                    {t("title")}
                  </s-table-header>

                  <s-table-header listSlot="inline">
                    {t("statusLabel")}
                  </s-table-header>

                  <s-table-header listSlot="inline">
                    {t("frequency")}
                  </s-table-header>

                  <s-table-header
                    listSlot="labeled"
                    format="numeric"
                  >
                    {t("runs")}
                  </s-table-header>

                  <s-table-header listSlot="labeled">
                    {t("created")}
                  </s-table-header>

                  <s-table-header listSlot="inline">
                    {t("actions")}
                  </s-table-header>
                </s-table-header-row>

                <s-table-body>
                  {items.map((item) => {
                    const id =
                      getRecurringItemId(
                        item,
                      );

                    if (!id) {
                      return null;
                    }

                    return (
                      <RecurringHistoryRow
                        key={id}
                        item={item}
                        dateTimeFormatter={
                          dateTimeFormatter
                        }
                        numberFormatter={
                          numberFormatter
                        }
                        onView={
                          onViewDetails
                        }
                        onDelete={
                          openDeleteModal
                        }
                        viewLabel={
                          viewLabel
                        }
                        deleteLabel={
                          deleteLabel
                        }
                        t={t}
                      />
                    );
                  })}
                </s-table-body>
              </s-table>
            ) : null}
          </s-stack>
        </s-section>

        {detailsOpen ? (
          <Suspense fallback={null}>
            <RecurringEditViewModal
              data={historyItem}
              error={detailsError}
              isLoading={isLoadingDetails}
              open
              onClose={closeDetailsModal}
              onUpdated={onRefresh}
            />
          </Suspense>
        ) : null}

        <s-modal
          ref={deleteModalRef}
          id={DELETE_MODAL_ID}
          heading={t(
            "deleteRecurringEdit",
          )}
          accessibilityLabel={t(
            "deleteRecurringEdit",
          )}
          onHide={
            handleDeleteModalHidden
          }
        >
          {detailsError &&
            deleteRecurringItem ? (
            <s-banner
              heading={t(
                "deleteRecurringFailed",
                {
                  defaultValue:
                    "Recurring edit could not be deleted",
                },
              )}
              tone="critical"
            >
              <s-paragraph>
                {detailsError}
              </s-paragraph>
            </s-banner>
          ) : null}

          <s-paragraph>
            {t(
              "deleteRecurringConfirmation",
              {
                title: deleteTitle,
              },
            )}
          </s-paragraph>

          <s-button
            slot="primary-action"
            variant="primary"
            tone="critical"
            loading={deleteLoading}
            disabled={
              deleteLoading ||
              !getRecurringItemId(
                deleteRecurringItem,
              )
            }
            onClick={
              handleDeleteRecurring
            }
          >
            {deleteLabel}
          </s-button>

          <s-button
            slot="secondary-actions"
            variant="secondary"
            disabled={deleteLoading}
            onClick={closeDeleteModal}
          >
            {t("common:cancel", {
              defaultValue: "Cancel",
            })}
          </s-button>
        </s-modal>
      </>
    );
  },
);

RecurringHistoryTable.displayName =
  "RecurringHistoryTable";

export default RecurringHistoryTable;
