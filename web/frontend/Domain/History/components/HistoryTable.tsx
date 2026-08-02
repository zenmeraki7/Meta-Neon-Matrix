import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import AlertUndo from "../../products/edit/components/AlertUndo";
import useProductSyncStatus from "../../../hooks/useProductSyncStatus";
import { historyService } from "../services/historyService";
import { useAuthenticatedFetch } from "../../../hooks/useAuthenticatedFetch";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import { getBrowserScheduleTimezone } from "../../../utils/scheduleTimezone";
import TableErrorBoundary from "../../../components/Error/TableErrorBoundary";
import JobProgressCell, {
  STATUS_CONFIG,
  normalizeJobStatus,
} from "./JobProgressCell";

const TERMINAL_UNDO_STATES = new Set<string>([
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);

export const HISTORY_TYPE = {
  MANUAL: "MANUAL",
  SCHEDULED: "SCHEDULED",
  RECURRING: "RECURRING",
} as const;

export type HistoryType =
  (typeof HISTORY_TYPE)[keyof typeof HISTORY_TYPE];

const TYPE_OPTIONS = [
  {
    labelKey: "historyTypeManualEdit",
    value: HISTORY_TYPE.MANUAL,
    defaultValue: "Manual edit",
  },
  {
    labelKey: "historyTypeScheduledEdit",
    value: HISTORY_TYPE.SCHEDULED,
    defaultValue: "Scheduled edit",
  },
  {
    labelKey: "historyTypeRecurringEdit",
    value: HISTORY_TYPE.RECURRING,
    defaultValue: "Recurring edit",
  },
] as const;

const STATUS_OPTIONS = [
  {
    labelKey: "historyStatusQueued",
    value: "queued",
    defaultValue: "Queued",
  },
  {
    labelKey: "historyStatusProcessing",
    value: "processing",
    defaultValue: "Processing",
  },
  {
    labelKey: "historyStatusCompleted",
    value: "completed",
    defaultValue: "Completed",
  },
  {
    labelKey: "historyStatusFailed",
    value: "failed",
    defaultValue: "Failed",
  },
  {
    labelKey: "historyStatusCancelled",
    value: "cancelled",
    defaultValue: "Cancelled",
  },
] as const;

type HistoryStatusFilter =
  (typeof STATUS_OPTIONS)[number]["value"];

type HistoryOption =
  | (typeof TYPE_OPTIONS)[number]
  | (typeof STATUS_OPTIONS)[number];

const STATUS_LABEL_KEYS = {
  COMPLETED: {
    key: "jobStatus.completed",
    defaultValue: "Completed",
  },
  FAILED: {
    key: "jobStatus.failed",
    defaultValue: "Failed",
  },
  RUNNING: {
    key: "jobStatus.running",
    defaultValue: "Running",
  },
  QUEUED: {
    key: "jobStatus.queued",
    defaultValue: "Queued",
  },
  PENDING: {
    key: "jobStatus.pending",
    defaultValue: "Waiting to start",
  },
  CANCELLED: {
    key: "jobStatus.cancelled",
    defaultValue: "Cancelled",
  },
  PARTIALLY_COMPLETED: {
    key: "jobStatus.partiallyCompleted",
    defaultValue: "Partially completed",
  },
  PARTIAL: {
    key: "jobStatus.partiallyCompleted",
    defaultValue: "Partially completed",
  },
  UNKNOWN: {
    key: "jobStatus.unknown",
    defaultValue: "Unknown",
  },
} as const;

type MerchantStatusKey = keyof typeof STATUS_LABEL_KEYS;

type BadgeTone =
  | "success"
  | "critical"
  | "warning"
  | "info";

type StringValueElement = HTMLElement & {
  value: string;
};

type StringValueEvent = FormEvent<StringValueElement>;

interface HistoryStatusSummary {
  key?: string | null;
  [key: string]: unknown;
}

interface HistoryUndoAvailability {
  available?: boolean | null;
  [key: string]: unknown;
}

interface HistoryPrimaryStatus {
  key?: string | null;
  [key: string]: unknown;
}

export interface HistoryItem {
  id?: string | number | null;
  operationId?: string | number | null;
  title?: string | null;
  editTypeLabel?: string | null;
  fieldType?: string | null;
  operationType?: string | null;

  status?: string | null;
  displayStatus?: string | null;
  primaryStatus?: HistoryPrimaryStatus | null;

  undoExecutionId?: string | null;
  undoStatus?: string | null;
  undoStatusSummary?: HistoryStatusSummary | null;
  undoAvailability?: HistoryUndoAvailability | null;

  totalCount?: number | string | null;
  totalItems?: number | string | null;
  processedCount?: number | string | null;
  progressProcessedCount?: number | string | null;
  successCount?: number | string | null;

  progressSummary?: {
    total?: number | string | null;
    [key: string]: unknown;
  } | null;

  affectedProducts?: number | string | null;
  productCount?: number | string | null;
  affectedVariants?: number | string | null;
  variantCount?: number | string | null;

  createdAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;

  [key: string]: unknown;
}

export interface HistoryQuery {
  limit?: number;
  search?: string;
  type?: HistoryType | "";
  status?: HistoryStatusFilter | string;
  frequency?: string;
  sortKey?: string;
  sortDirection?: "asc" | "desc";
}

export interface HistoryPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor?: string | null;
}

interface UndoSummary {
  label: string;
  affectedProducts: number | string | null;
  affectedVariants: number | string | null;
  createdAt: string | number | Date | null;
  operationId: string | null;
  historyId: string | null;
}

interface UndoRequestInput {
  historyId?: unknown;
  operationId?: unknown;
  idempotencyKey?: unknown;
}

interface UndoRequestResponse {
  status?: string | null;
  undoExecutionId?: string | null;
  [key: string]: unknown;
}

interface UndoStatusResponse {
  status?: string | null;
  undoStatus?: string | null;
  operationId?: string | null;
  historyId?: string | null;
  terminal?: boolean | null;
  [key: string]: unknown;
}

interface HistoryListCache {
  items?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

interface ErrorWithMetadata extends Error {
  code?: string;
  payload?: {
    code?: string;
    [key: string]: unknown;
  };
}

interface HistoryTableProps {
  histories: readonly HistoryItem[];
  isLoading: boolean;
  pageInfo: HistoryPageInfo;
  query: HistoryQuery;
  querySearch: string;
  hasActiveFilters?: boolean;
  onSearchChange: (value: string) => void;
  onQueryChange: (
    patch: Partial<HistoryQuery>,
  ) => void;
  onQueryClear: () => void;
  onNext: () => void;
  onPrevious: () => void;
  emptyStateMessage: string;
}

interface MerchantStatusBadgeProps {
  item: HistoryItem;
  t: TFunction;
}

interface HistoryRowActionsProps {
  rowId: string;
  history: HistoryItem;
  onView: (rowId: string) => void;
  onUndo: (history: HistoryItem) => void;
  undoDisabled: boolean;
  viewLabel: string;
  undoLabel: string;
}

interface HistoryRowProps {
  item: HistoryItem;
  rowId: string;
  totalCount: number;
  statusKey: string;
  isSyncInProgress: boolean;
  dateTimeFormatter: Intl.DateTimeFormat;
  viewLabel: string;
  undoLabel: string;
  onView: (rowId: string) => void;
  onUndo: (history: HistoryItem) => void;
  t: TFunction;
}

interface HistoryResultsProps {
  historyItems: readonly HistoryItem[];
  isLoading: boolean;
  pageInfo: HistoryPageInfo;
  onNext: () => void;
  onPrevious: () => void;
  emptyStateMessage: string;
  dateTimeFormatter: Intl.DateTimeFormat;
  isSyncInProgress: boolean;
  handleView: (rowId: string) => void;
  handleUndo: (history: HistoryItem) => void;
  viewLabel: string;
  undoLabel: string;
  t: TFunction;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isHistoryItem(
  value: unknown,
): value is HistoryItem {
  return isRecord(value);
}

function toErrorWithMetadata(
  error: unknown,
): ErrorWithMetadata {
  if (error instanceof Error) {
    return error as ErrorWithMetadata;
  }

  return new Error(
    typeof error === "string"
      ? error
      : "Unexpected error",
  );
}

function getOptionLabel(
  options: readonly HistoryOption[],
  value: string,
  t: TFunction,
): string {
  const option = options.find(
    (candidate) => candidate.value === value,
  );

  return option
    ? t(option.labelKey, {
        defaultValue: option.defaultValue,
      })
    : value;
}

function logUndoClient(
  event: string,
  detail: Readonly<Record<string, unknown>> = {},
): void {
  const isDev = Boolean(
    (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV,
  );

  if (isDev) {
    console.info(`undo.client.${event}`, detail);
  }
}

function safeString(
  value: unknown,
  fallback: string | null = null,
  maxLength: number | null = 120,
): string | null {
  if (value === undefined || value === null) {
    return fallback;
  }

  const stringValue = String(value).trim();

  if (!stringValue) {
    return fallback;
  }

  if (
    maxLength === null ||
    !Number.isFinite(maxLength) ||
    maxLength <= 0
  ) {
    return stringValue;
  }

  return stringValue.length > maxLength
    ? `${stringValue.slice(0, maxLength)}...`
    : stringValue;
}

function createUndoIdempotencyKey(
  operationId: string,
): string {
  const nonce =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

  return `undo:${operationId}:${nonce}`;
}

function updateUndoStatusInHistoryCache(
  current: unknown,
  undoExecutionId: string,
  statusObj: UndoStatusResponse,
): unknown {
  if (!isRecord(current)) {
    return current;
  }

  const cache = current as HistoryListCache;
  const items = cache.items ?? cache.data;

  if (!Array.isArray(items)) {
    return current;
  }

  const newStatus =
    safeString(
      statusObj.status ?? statusObj.undoStatus,
      null,
      null,
    ) ?? null;

  if (!newStatus) {
    return current;
  }

  let changed = false;

  const updatedItems = items.map((value) => {
    if (!isHistoryItem(value)) {
      return value;
    }

    const matches =
      value.undoExecutionId === undoExecutionId ||
      value.operationId === statusObj.operationId ||
      value.id === statusObj.historyId;

    if (!matches) {
      return value;
    }

    changed = true;

    return {
      ...value,
      undoStatus: newStatus,
      undoStatusSummary: {
        ...(isRecord(value.undoStatusSummary)
          ? value.undoStatusSummary
          : {}),
        key: newStatus,
      },
    } satisfies HistoryItem;
  });

  if (!changed) {
    return current;
  }

  if (Array.isArray(cache.items)) {
    return {
      ...cache,
      items: updatedItems,
    };
  }

  return {
    ...cache,
    data: updatedItems,
  };
}

function getMerchantStatusKey(
  item: HistoryItem,
): MerchantStatusKey {
  const normalized = normalizeJobStatus(item);

  if (
    typeof normalized === "string" &&
    normalized in STATUS_LABEL_KEYS
  ) {
    return normalized as MerchantStatusKey;
  }

  return "UNKNOWN";
}

function getJobTotalCount(
  item: HistoryItem,
): number {
  const candidates: unknown[] = [
    item.totalCount,
    item.totalItems,
    item.progressSummary?.total,
  ];

  for (const candidate of candidates) {
    if (
      candidate === null ||
      candidate === undefined ||
      candidate === "" ||
      typeof candidate === "boolean"
    ) {
      continue;
    }

    const count = Number(candidate);

    if (Number.isFinite(count) && count >= 0) {
      return Math.trunc(count);
    }
  }

  return 0;
}

function getStatusTone(
  statusKey: MerchantStatusKey,
): BadgeTone | undefined {
  const config = STATUS_CONFIG[statusKey];
  const tone = config?.tone;

  if (
    tone === "success" ||
    tone === "critical" ||
    tone === "warning" ||
    tone === "info"
  ) {
    return tone;
  }

  return undefined;
}

function MerchantStatusBadge({
  item,
  t,
}: MerchantStatusBadgeProps) {
  const statusKey = getMerchantStatusKey(item);
  const label =
    STATUS_LABEL_KEYS[statusKey] ??
    STATUS_LABEL_KEYS.UNKNOWN;
  const tone = getStatusTone(statusKey);

  return (
    <s-badge {...(tone ? { tone } : {})}>
      {t(label.key, {
        defaultValue: label.defaultValue,
      })}
    </s-badge>
  );
}

function isUndoDisabled(
  item: HistoryItem,
  syncInProgress: boolean,
): boolean {
  if (syncInProgress) {
    return true;
  }

  const historyId = safeString(
    item.id,
    null,
    null,
  );

  const operationId = safeString(
    item.operationId ?? historyId,
    null,
    null,
  );

  if (!historyId || !operationId) {
    return true;
  }

  if (item.undoAvailability?.available !== true) {
    return true;
  }

  const undoState = (
    safeString(
      item.undoStatusSummary?.key ??
        item.undoStatus,
      "",
      null,
    ) ?? ""
  ).toUpperCase();

  return (
    undoState.startsWith("UNDO_") ||
    undoState === "COMPLETED"
  );
}

function formatUpdatedAt(
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

function waitForDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(
        new DOMException(
          "Polling aborted",
          "AbortError",
        ),
      );
      return;
    }

    function handleAbort(): void {
      window.clearTimeout(timeoutId);
      signal.removeEventListener(
        "abort",
        handleAbort,
      );

      reject(
        new DOMException(
          "Polling aborted",
          "AbortError",
        ),
      );
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener(
        "abort",
        handleAbort,
      );
      resolve();
    }, delayMs);

    signal.addEventListener(
      "abort",
      handleAbort,
      { once: true },
    );
  });
}

function updateHistoryCaches(
  queryClient: QueryClient,
  undoExecutionId: string,
  status: UndoStatusResponse,
): void {
  queryClient.setQueriesData(
    {
      queryKey: ["history-list"],
    },
    (current: unknown) =>
      updateUndoStatusInHistoryCache(
        current,
        undoExecutionId,
        status,
      ),
  );
}

const HistoryRowActions = memo(
  function HistoryRowActions({
    rowId,
    history,
    onView,
    onUndo,
    undoDisabled,
    viewLabel,
    undoLabel,
  }: HistoryRowActionsProps) {
    const handleViewClick = useCallback(() => {
      onView(rowId);
    }, [onView, rowId]);

    const handleUndoClick = useCallback(() => {
      onUndo(history);
    }, [history, onUndo]);

    return (
      <s-button-group gap="base">
        <s-button
          variant="secondary"
          onClick={handleViewClick}
        >
          {viewLabel}
        </s-button>

        <s-button
          variant="secondary"
          disabled={undoDisabled}
          onClick={handleUndoClick}
        >
          {undoLabel}
        </s-button>
      </s-button-group>
    );
  },
);

const HistoryRow = memo(function HistoryRow({
  item,
  rowId,
  totalCount,
  statusKey,
  isSyncInProgress,
  dateTimeFormatter,
  viewLabel,
  undoLabel,
  onView,
  onUndo,
  t,
}: HistoryRowProps) {
  const unavailableLabel = t(
    "common:unavailable",
    {
      defaultValue: "—",
    },
  );

  const secondaryContext =
    safeString(item.editTypeLabel) ??
    safeString(item.fieldType) ??
    safeString(item.operationType);

  const title =
    safeString(item.title) ??
    unavailableLabel;

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack gap="small-200">
          <s-text type="strong">
            {title}
          </s-text>

          {secondaryContext ? (
            <s-text color="subdued">
              {secondaryContext}
            </s-text>
          ) : null}
        </s-stack>
      </s-table-cell>

      <s-table-cell>
        <MerchantStatusBadge
          item={item}
          t={t}
        />
      </s-table-cell>

      <s-table-cell>
        <JobProgressCell
          job={item}
          processedCount={
            item.processedCount ?? 0
          }
          progressProcessedCount={
            item.progressProcessedCount ??
            item.successCount ??
            0
          }
          totalCount={totalCount}
          status={statusKey}
        />
      </s-table-cell>

      <s-table-cell>
        <s-text>
          {formatUpdatedAt(
            item.updatedAt,
            dateTimeFormatter,
            unavailableLabel,
          )}
        </s-text>
      </s-table-cell>

      <s-table-cell>
        <HistoryRowActions
          rowId={rowId}
          history={item}
          onView={onView}
          onUndo={onUndo}
          undoDisabled={isUndoDisabled(
            item,
            isSyncInProgress,
          )}
          viewLabel={viewLabel}
          undoLabel={undoLabel}
        />
      </s-table-cell>
    </s-table-row>
  );
});

const HistoryResults = memo(
  function HistoryResults({
    historyItems,
    isLoading,
    pageInfo,
    onNext,
    onPrevious,
    emptyStateMessage,
    dateTimeFormatter,
    isSyncInProgress,
    handleView,
    handleUndo,
    viewLabel,
    undoLabel,
    t,
  }: HistoryResultsProps) {
    if (
      !isLoading &&
      historyItems.length === 0
    ) {
      return (
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
              {t("historyEmptyStateTitle", {
                defaultValue:
                  "No history found",
              })}
            </s-heading>

            <s-paragraph color="subdued">
              {emptyStateMessage}
            </s-paragraph>
          </s-stack>
        </s-grid>
      );
    }

    const hasPagination =
      pageInfo.hasNextPage ||
      pageInfo.hasPreviousPage;

    return (
      <TableErrorBoundary>
        <s-table
          variant="auto"
          loading={isLoading}
          paginate={hasPagination}
          hasNextPage={
            !isLoading &&
            pageInfo.hasNextPage
          }
          hasPreviousPage={
            !isLoading &&
            pageInfo.hasPreviousPage
          }
          onNextPage={
            isLoading ? undefined : onNext
          }
          onPreviousPage={
            isLoading
              ? undefined
              : onPrevious
          }
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">
              {t("historyColumnTitle")}
            </s-table-header>

            <s-table-header listSlot="inline">
              {t("historyColumnStatus")}
            </s-table-header>

            <s-table-header listSlot="labeled">
              {t("historyColumnProcessed")}
            </s-table-header>

            <s-table-header listSlot="labeled">
              {t("historyColumnUpdated")}
            </s-table-header>

            <s-table-header listSlot="inline">
              {t("historyColumnActions")}
            </s-table-header>
          </s-table-header-row>

          <s-table-body>
            {historyItems.map((item) => {
              const id = safeString(
                item.id,
                null,
                null,
              );

              if (!id) {
                return null;
              }

              return (
                <HistoryRow
                  key={id}
                  item={item}
                  rowId={id}
                  totalCount={getJobTotalCount(
                    item,
                  )}
                  statusKey={getMerchantStatusKey(
                    item,
                  )}
                  isSyncInProgress={
                    isSyncInProgress
                  }
                  dateTimeFormatter={
                    dateTimeFormatter
                  }
                  viewLabel={viewLabel}
                  undoLabel={undoLabel}
                  onView={handleView}
                  onUndo={handleUndo}
                  t={t}
                />
              );
            })}
          </s-table-body>
        </s-table>
      </TableErrorBoundary>
    );
  },
);

const HistoryTable = memo(function HistoryTable({
  histories,
  isLoading,
  pageInfo,
  query,
  querySearch,
  hasActiveFilters,
  onSearchChange,
  onQueryChange,
  onQueryClear,
  onNext,
  onPrevious,
  emptyStateMessage,
}: HistoryTableProps) {
  const navigate = useNavigate();

  const { t } = useTranslation([
    "history",
    "common",
  ]);

  const queryClient = useQueryClient();

  const authenticatedFetch =
    useAuthenticatedFetch();

  const { dateTimeFormatter } =
    useLocaleFormatters();

  const displayTimezone = useMemo(
    () =>
      getBrowserScheduleTimezone() ||
      "Asia/Kolkata",
    [],
  );

  const { isSyncInProgress } =
    useProductSyncStatus();

  const [showUndoModal, setShowUndoModal] =
    useState<boolean>(false);

  const [undoLoading, setUndoLoading] =
    useState<boolean>(false);

  const [
    undoHistoryItem,
    setUndoHistoryItem,
  ] = useState<HistoryItem | null>(null);

  const [
    undoIdempotencyKey,
    setUndoIdempotencyKey,
  ] = useState<string | null>(null);

  const [
    undoMonitoringError,
    setUndoMonitoringError,
  ] = useState<string | null>(null);

  const historyItems = useMemo<HistoryItem[]>(
    () =>
      histories.filter((item) =>
        Boolean(
          safeString(item.id, null, null),
        ),
      ),
    [histories],
  );

  const mountedRef = useRef<boolean>(true);

  const undoRequestRef =
    useRef<Promise<UndoRequestResponse> | null>(
      null,
    );

  const pollingAbortRef =
    useRef<AbortController | null>(null);

  const activeFiltersPresent =
    typeof hasActiveFilters === "boolean"
      ? hasActiveFilters
      : Boolean(
          querySearch.trim() ||
            query.type ||
            query.status,
        );

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      pollingAbortRef.current?.abort();
      pollingAbortRef.current = null;
    };
  }, []);

  const handleSearchInput = useCallback(
    (event: StringValueEvent): void => {
      onSearchChange(
        event.currentTarget.value,
      );
    },
    [onSearchChange],
  );

  const handleTypeChange = useCallback(
    (event: StringValueEvent): void => {
      const value =
        event.currentTarget.value;

      onQueryChange({
        type:
          value === HISTORY_TYPE.MANUAL ||
          value === HISTORY_TYPE.SCHEDULED ||
          value === HISTORY_TYPE.RECURRING
            ? value
            : "",
      });
    },
    [onQueryChange],
  );

  const handleStatusChange = useCallback(
    (event: StringValueEvent): void => {
      onQueryChange({
        status: event.currentTarget.value,
      });
    },
    [onQueryChange],
  );

  const handleUndo = useCallback(
    (history: HistoryItem): void => {
      const historyId = safeString(
        history.id,
        null,
        null,
      );

      const operationId = safeString(
        history.operationId ?? historyId,
        null,
        null,
      );

      if (!historyId || !operationId) {
        return;
      }

      logUndoClient("confirm_clicked", {
        historyId,
        operationId,
        status:
          history.status ??
          history.primaryStatus?.key ??
          null,
      });

      setUndoHistoryItem(history);
      setUndoMonitoringError(null);
      setUndoIdempotencyKey(
        createUndoIdempotencyKey(
          operationId,
        ),
      );
      setShowUndoModal(true);
    },
    [],
  );

  const handleView = useCallback(
    (rowId: string): void => {
      navigate(
        `/editDetails/${encodeURIComponent(
          rowId,
        )}`,
      );
    },
    [navigate],
  );

  const handleCloseUndoModal =
    useCallback((): void => {
      setShowUndoModal(false);
      setUndoHistoryItem(null);
      setUndoIdempotencyKey(null);
    }, []);

  const handleUndoEditHistory = useCallback(
    async (
      input: UndoRequestInput = {},
    ): Promise<UndoRequestResponse> => {
      const targetHistoryId = safeString(
        input.historyId ??
          undoHistoryItem?.id,
        null,
        null,
      );

      const targetOperationId = safeString(
        input.operationId ??
          undoHistoryItem?.operationId ??
          targetHistoryId,
        null,
        null,
      );

      if (
        !targetHistoryId ||
        targetHistoryId.includes("...")
      ) {
        const error = new Error(
          "A full immutable history id is required.",
        ) as ErrorWithMetadata;

        error.code = "INVALID_HISTORY_ID";
        throw error;
      }

      if (
        !targetOperationId ||
        targetOperationId.includes("...")
      ) {
        const error = new Error(
          "A full immutable operation id is required.",
        ) as ErrorWithMetadata;

        error.code =
          "INVALID_OPERATION_ID";
        throw error;
      }

      if (undoRequestRef.current) {
        return undoRequestRef.current;
      }

      const suppliedIdempotencyKey =
        safeString(
          input.idempotencyKey,
          null,
          null,
        );

      const request =
        (async (): Promise<UndoRequestResponse> => {
          if (mountedRef.current) {
            setUndoLoading(true);
          }

          try {
            const requestUrl =
              `/api/history/${encodeURIComponent(
                targetHistoryId,
              )}/undo`;

            logUndoClient(
              "request_started",
              {
                historyId: targetHistoryId,
                requestUrl,
              },
            );

            const rawResponse =
              await historyService.requestUndo(
                targetHistoryId,
                targetOperationId,
                suppliedIdempotencyKey ??
                  undoIdempotencyKey,
                authenticatedFetch,
              );

            const response: UndoRequestResponse =
              isRecord(rawResponse)
                ? rawResponse
                : {};

            logUndoClient(
              "response_received",
              {
                historyId: targetHistoryId,
                status:
                  response.status ?? null,
                undoExecutionId:
                  response.undoExecutionId ??
                  null,
              },
            );

            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: [
                  "history-list",
                ],
              }),
              queryClient.invalidateQueries({
                queryKey: [
                  "edit-history-summary",
                ],
              }),
            ]);

            const undoExecutionId =
              safeString(
                response.undoExecutionId,
                null,
                null,
              );

            if (undoExecutionId) {
              pollingAbortRef.current?.abort();

              const controller =
                new AbortController();

              pollingAbortRef.current =
                controller;

              void (async (): Promise<void> => {
                let previousStatus:
                  | string
                  | null = null;

                for (
                  let attempt = 0;
                  attempt < 12 &&
                  !controller.signal.aborted;
                  attempt += 1
                ) {
                  const delayMs = Math.min(
                    2_000 *
                      1.35 ** attempt,
                    10_000,
                  );

                  try {
                    await waitForDelay(
                      delayMs,
                      controller.signal,
                    );

                    const rawStatus =
                      await historyService.getUndoStatus(
                        undoExecutionId,
                        controller.signal,
                      );

                    const status: UndoStatusResponse =
                      isRecord(rawStatus)
                        ? rawStatus
                        : {};

                    const normalizedStatus = (
                      safeString(
                        status.status ??
                          status.undoStatus,
                        "",
                        null,
                      ) ?? ""
                    ).toUpperCase();

                    if (
                      normalizedStatus &&
                      normalizedStatus !==
                        previousStatus
                    ) {
                      previousStatus =
                        normalizedStatus;

                      updateHistoryCaches(
                        queryClient,
                        undoExecutionId,
                        status,
                      );
                    }

                    const isTerminal =
                      status.terminal === true ||
                      TERMINAL_UNDO_STATES.has(
                        normalizedStatus,
                      );

                    if (isTerminal) {
                      await queryClient.invalidateQueries(
                        {
                          queryKey: [
                            "history-list",
                          ],
                        },
                      );

                      if (
                        pollingAbortRef.current ===
                        controller
                      ) {
                        pollingAbortRef.current =
                          null;
                      }

                      return;
                    }
                  } catch (error) {
                    const normalizedError =
                      toErrorWithMetadata(
                        error,
                      );

                    if (
                      normalizedError.name ===
                      "AbortError"
                    ) {
                      return;
                    }

                    break;
                  }
                }

                if (
                  !controller.signal.aborted &&
                  mountedRef.current
                ) {
                  setUndoMonitoringError(
                    t(
                      "undoStatusUnavailable",
                      {
                        defaultValue:
                          "Undo started, but its latest status could not be loaded. Refresh the history to check it.",
                      },
                    ),
                  );
                }

                if (
                  pollingAbortRef.current ===
                  controller
                ) {
                  pollingAbortRef.current =
                    null;
                }
              })();
            }

            return response;
          } catch (error) {
            const normalizedError =
              toErrorWithMetadata(error);

            logUndoClient(
              "request_failed",
              {
                historyId: targetHistoryId,
                name:
                  normalizedError.name ||
                  "Error",
                code:
                  normalizedError.code ??
                  normalizedError.payload
                    ?.code ??
                  null,
                message:
                  normalizedError.message ||
                  "Undo request failed",
              },
            );

            throw normalizedError;
          } finally {
            undoRequestRef.current = null;

            if (mountedRef.current) {
              setUndoLoading(false);
            }
          }
        })();

      undoRequestRef.current = request;

      return request;
    },
    [
      authenticatedFetch,
      queryClient,
      t,
      undoHistoryItem,
      undoIdempotencyKey,
    ],
  );

  const undoSummary =
    useMemo<UndoSummary | null>(() => {
      if (!undoHistoryItem) {
        return null;
      }

      return {
        label:
          safeString(
            undoHistoryItem.editTypeLabel,
          ) ??
          safeString(
            undoHistoryItem.title,
          ) ??
          "Bulk edit",
        affectedProducts:
          undoHistoryItem.affectedProducts ??
          undoHistoryItem.productCount ??
          null,
        affectedVariants:
          undoHistoryItem.affectedVariants ??
          undoHistoryItem.variantCount ??
          null,
        createdAt:
          undoHistoryItem.createdAt ??
          undoHistoryItem.updatedAt ??
          null,
        operationId: safeString(
          undoHistoryItem.operationId ??
            undoHistoryItem.id,
          null,
          null,
        ),
        historyId: safeString(
          undoHistoryItem.id,
          null,
          null,
        ),
      };
    }, [undoHistoryItem]);

  const viewLabel = t(
    "historyViewButton",
    {
      defaultValue: "View",
    },
  );

  const undoLabel = t(
    "historyUndoButton",
    {
      defaultValue: "Undo",
    },
  );

  return (
    <s-section
      padding="none"
      accessibilityLabel={t(
        "historyTableLabel",
        {
          defaultValue: "Edit history",
        },
      )}
    >
      <s-stack gap="none">
        {undoMonitoringError ? (
          <s-box padding="base">
            <s-banner
              heading={t(
                "undoStatusWarning",
                {
                  defaultValue:
                    "Undo Status Warning",
                },
              )}
              tone="warning"
              onDismiss={() =>
                setUndoMonitoringError(null)
              }
            >
              <s-paragraph>
                {undoMonitoringError}
              </s-paragraph>
            </s-banner>
          </s-box>
        ) : null}

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
                  "historySearchLabel",
                  {
                    defaultValue:
                      "Search history",
                  },
                )}
                labelAccessibilityVisibility="exclusive"
                name="history-search"
                placeholder={t(
                  "historySearchPlaceholder",
                  {
                    defaultValue:
                      "Search history",
                  },
                )}
                value={querySearch}
                autocomplete="off"
                onInput={handleSearchInput}
              />

              <s-select
                label={t(
                  "historyFilterType",
                  {
                    defaultValue: "Type",
                  },
                )}
                name="history-type"
                value={query.type ?? ""}
                onChange={handleTypeChange}
              >
                <s-option value="">
                  {t(
                    "historyFilterAllTypes",
                    {
                      defaultValue:
                        "All types",
                    },
                  )}
                </s-option>

                {TYPE_OPTIONS.map(
                  (option) => (
                    <s-option
                      key={option.value}
                      value={option.value}
                    >
                      {t(option.labelKey, {
                        defaultValue:
                          option.defaultValue,
                      })}
                    </s-option>
                  ),
                )}
              </s-select>

              <s-select
                label={t(
                  "historyFilterStatus",
                  {
                    defaultValue:
                      "Status",
                  },
                )}
                name="history-status"
                value={query.status ?? ""}
                onChange={
                  handleStatusChange
                }
              >
                <s-option value="">
                  {t(
                    "historyFilterAllStatuses",
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
                      value={option.value}
                    >
                      {t(option.labelKey, {
                        defaultValue:
                          option.defaultValue,
                      })}
                    </s-option>
                  ),
                )}
              </s-select>

              <s-button
                variant="secondary"
                disabled={
                  !activeFiltersPresent
                }
                onClick={onQueryClear}
              >
                {t(
                  "historyClearFilters",
                  {
                    defaultValue:
                      "Clear filters",
                  },
                )}
              </s-button>
            </s-grid>

            {query.type ||
            query.status ? (
              <s-stack
                direction="inline"
                gap="small"
                alignItems="center"
              >
                {query.type ? (
                  <s-badge>
                    {getOptionLabel(
                      TYPE_OPTIONS,
                      query.type,
                      t,
                    )}
                  </s-badge>
                ) : null}

                {query.status ? (
                  <s-badge>
                    {getOptionLabel(
                      STATUS_OPTIONS,
                      query.status,
                      t,
                    )}
                  </s-badge>
                ) : null}
              </s-stack>
            ) : null}
          </s-stack>
        </s-box>

        <HistoryResults
          historyItems={historyItems}
          isLoading={isLoading}
          pageInfo={pageInfo}
          onNext={onNext}
          onPrevious={onPrevious}
          emptyStateMessage={
            emptyStateMessage
          }
          dateTimeFormatter={
            dateTimeFormatter
          }
          isSyncInProgress={
            Boolean(isSyncInProgress)
          }
          handleView={handleView}
          handleUndo={handleUndo}
          viewLabel={viewLabel}
          undoLabel={undoLabel}
          t={t}
        />

        {showUndoModal ? (
          <AlertUndo
            show={showUndoModal}
            handleClose={
              handleCloseUndoModal
            }
            undoEditHistory={
              handleUndoEditHistory
            }
            loading={undoLoading}
            undoSummary={undoSummary}
            idempotencyKey={
              undoIdempotencyKey
            }
            displayTimezone={
              displayTimezone
            }
          />
        ) : null}
      </s-stack>
    </s-section>
  );
});

HistoryTable.displayName = "HistoryTable";

export default HistoryTable;
