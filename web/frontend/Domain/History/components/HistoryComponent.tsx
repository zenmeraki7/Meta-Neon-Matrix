import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import HistoryTable, {
  HISTORY_TYPE,
} from "./HistoryTable";
import { toSafeErrorMessage } from "../../../utils/frontendError";
import useDebouncedValue from "../../../hooks/useDebouncedValue";
import {
  useHistoryListQuery,
  type HistoryRecord,
  type HistoryListResponse,
} from "../hooks/useHistoryListQuery";

const SORT_DIRECTION = {
  ASCENDING: "asc",
  DESCENDING: "desc",
} as const;

type SortDirection =
  (typeof SORT_DIRECTION)[keyof typeof SORT_DIRECTION];

type HistoryType =
  (typeof HISTORY_TYPE)[keyof typeof HISTORY_TYPE];

type HistoryTypeFilter = HistoryType | "";

export const HISTORY_STATUS = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const);

type HistoryStatus =
  (typeof HISTORY_STATUS)[keyof typeof HISTORY_STATUS];

type HistoryStatusFilter = HistoryStatus | "";

export const HISTORY_SORT_KEY = Object.freeze({
  CREATED_AT: "createdAt",
  UPDATED_AT: "updatedAt",
  STATUS: "status",
} as const);

type HistorySortKey =
  (typeof HISTORY_SORT_KEY)[keyof typeof HISTORY_SORT_KEY];

export const HISTORY_FREQUENCY = Object.freeze({
  ONCE: "once",
  DAILY: "daily",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
} as const);

type HistoryFrequency =
  (typeof HISTORY_FREQUENCY)[keyof typeof HISTORY_FREQUENCY];

type HistoryFrequencyFilter = HistoryFrequency | "";

interface HistoryQuery {
  limit: number;
  search: string;
  type: HistoryTypeFilter;
  status: HistoryStatusFilter;
  frequency: HistoryFrequencyFilter;
  sortKey: HistorySortKey;
  sortDirection: SortDirection;
}

type HistoryQueryPatch = Partial<HistoryQuery>;

interface PaginationState {
  cursors: Array<string | null>;
  cursorIndex: number;
  language: string;
}

interface HistoryState {
  query: HistoryQuery;
  pagination: PaginationState;
}

type HistoryAction =
  | { type: "PATCH_QUERY"; patch: HistoryQueryPatch }
  | { type: "APPLY_SEARCH"; search: string }
  | { type: "CLEAR_QUERY" }
  | { type: "SYNC_LANGUAGE"; language: string }
  | { type: "GO_TO_NEXT_PAGE"; nextCursor: string }
  | { type: "GO_TO_PREVIOUS_PAGE" };

interface NormalizedPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextCursor: string | null;
}

const DEFAULT_QUERY: Readonly<HistoryQuery> = Object.freeze({
  limit: 20,
  search: "",
  type: HISTORY_TYPE.MANUAL,
  status: "",
  frequency: "",
  sortKey: HISTORY_SORT_KEY.CREATED_AT,
  sortDirection: SORT_DIRECTION.DESCENDING,
});

function isRecord(value: unknown): value is HistoryRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function hasHistoryId(item: HistoryRecord): boolean {
  const id = item.id;

  if (typeof id !== "string" && typeof id !== "number") {
    return false;
  }

  return String(id).trim().length > 0;
}

function normalizeCursor(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cursor = value.trim();

  return cursor || null;
}

function isHistoryType(value: string): value is HistoryType {
  return Object.values(HISTORY_TYPE).some(
    (historyType) => historyType === value,
  );
}

function isHistoryStatus(value: string): value is HistoryStatus {
  return Object.values(HISTORY_STATUS).some(
    (status) => status === value,
  );
}

function isHistorySortKey(value: string): value is HistorySortKey {
  return Object.values(HISTORY_SORT_KEY).some(
    (sortKey) => sortKey === value,
  );
}

function isHistoryFrequency(value: string): value is HistoryFrequency {
  return Object.values(HISTORY_FREQUENCY).some(
    (freq) => freq === value,
  );
}

function normalizeQueryPatch(
  patch: unknown,
): HistoryQueryPatch {
  if (!isRecord(patch)) {
    return {};
  }

  const normalized: HistoryQueryPatch = {};

  if (
    typeof patch.limit === "number" &&
    Number.isInteger(patch.limit) &&
    patch.limit >= 1 &&
    patch.limit <= 100
  ) {
    normalized.limit = patch.limit;
  }

  if (typeof patch.type === "string") {
    const type = patch.type.trim();

    if (type === "" || isHistoryType(type)) {
      normalized.type = type as HistoryTypeFilter;
    }
  }

  if (typeof patch.status === "string") {
    const status = patch.status.trim();

    if (status === "" || isHistoryStatus(status)) {
      normalized.status = status as HistoryStatusFilter;
    }
  }

  if (typeof patch.frequency === "string") {
    const frequency = patch.frequency.trim();

    if (frequency === "" || isHistoryFrequency(frequency)) {
      normalized.frequency = frequency as HistoryFrequencyFilter;
    }
  }

  if (typeof patch.sortKey === "string") {
    const sortKey = patch.sortKey.trim();

    if (isHistorySortKey(sortKey)) {
      normalized.sortKey = sortKey;
    }
  }

  if (
    patch.sortDirection === SORT_DIRECTION.ASCENDING ||
    patch.sortDirection === SORT_DIRECTION.DESCENDING
  ) {
    normalized.sortDirection = patch.sortDirection;
  }

  return normalized;
}

function extractHistoryRecords(
  response: HistoryListResponse | undefined,
): HistoryRecord[] {
  const result = response?.items ?? response?.data ?? [];

  if (!Array.isArray(result)) {
    return [];
  }

  return result.filter(
    (item): item is HistoryRecord =>
      isRecord(item) && hasHistoryId(item),
  );
}

function createInitialState(language: string): HistoryState {
  return {
    query: { ...DEFAULT_QUERY },
    pagination: {
      cursors: [null],
      cursorIndex: 0,
      language,
    },
  };
}

function historyReducer(
  state: HistoryState,
  action: HistoryAction,
): HistoryState {
  switch (action.type) {
    case "PATCH_QUERY": {
      const normalized = action.patch;
      const changed = Object.entries(normalized).some(([key, value]) => {
        const queryKey = key as keyof HistoryQuery;
        return state.query[queryKey] !== value;
      });

      if (!changed) {
        return state;
      }

      return {
        query: {
          ...state.query,
          ...normalized,
        },
        pagination: {
          cursors: [null],
          cursorIndex: 0,
          language: state.pagination.language,
        },
      };
    }

    case "APPLY_SEARCH": {
      if (state.query.search === action.search) {
        return state;
      }

      return {
        query: {
          ...state.query,
          search: action.search,
        },
        pagination: {
          cursors: [null],
          cursorIndex: 0,
          language: state.pagination.language,
        },
      };
    }

    case "CLEAR_QUERY": {
      const nextQuery: HistoryQuery = {
        ...state.query,
        type: DEFAULT_QUERY.type,
        status: DEFAULT_QUERY.status,
        frequency: DEFAULT_QUERY.frequency,
        sortKey: DEFAULT_QUERY.sortKey,
        sortDirection: DEFAULT_QUERY.sortDirection,
      };

      const changed =
        state.query.type !== nextQuery.type ||
        state.query.status !== nextQuery.status ||
        state.query.frequency !== nextQuery.frequency ||
        state.query.sortKey !== nextQuery.sortKey ||
        state.query.sortDirection !== nextQuery.sortDirection;

      if (!changed) {
        return state;
      }

      return {
        query: nextQuery,
        pagination: {
          cursors: [null],
          cursorIndex: 0,
          language: state.pagination.language,
        },
      };
    }

    case "SYNC_LANGUAGE": {
      if (state.pagination.language === action.language) {
        return state;
      }

      return {
        ...state,
        pagination: {
          cursors: [null],
          cursorIndex: 0,
          language: action.language,
        },
      };
    }

    case "GO_TO_NEXT_PAGE": {
      const { nextCursor } = action;

      const currentCursor =
        state.pagination.cursors[state.pagination.cursorIndex] ?? null;

      if (nextCursor === currentCursor) {
        return state;
      }

      const nextIndex = state.pagination.cursorIndex + 1;

      return {
        ...state,
        pagination: {
          ...state.pagination,
          cursors: [
            ...state.pagination.cursors.slice(0, nextIndex),
            nextCursor,
          ],
          cursorIndex: nextIndex,
        },
      };
    }

    case "GO_TO_PREVIOUS_PAGE": {
      if (state.pagination.cursorIndex === 0) {
        return state;
      }

      return {
        ...state,
        pagination: {
          ...state.pagination,
          cursorIndex: state.pagination.cursorIndex - 1,
        },
      };
    }

    default:
      return state;
  }
}

function HistoryComponent() {
  const { t, i18n } = useTranslation();

  const language =
    i18n.resolvedLanguage || i18n.language || "en";

  const [state, dispatch] = useReducer(
    historyReducer,
    language,
    createInitialState,
  );

  const { query, pagination } = state;

  const [searchDraft, setSearchDraft] = useState<string>(
    DEFAULT_QUERY.search,
  );

  const debouncedSearchDraft = useDebouncedValue(
    searchDraft,
    400,
  );

  useEffect(() => {
    dispatch({ type: "SYNC_LANGUAGE", language });
  }, [language]);

  useEffect(() => {
    dispatch({
      type: "APPLY_SEARCH",
      search: debouncedSearchDraft,
    });
  }, [debouncedSearchDraft]);

  const activeCursor =
    pagination.language === language
      ? pagination.cursors[pagination.cursorIndex] ?? null
      : null;

  const historyQuery = useHistoryListQuery({
    query,
    cursor: activeCursor,
    lang: language,
  });

  const queryBusy =
    historyQuery.isLoading || historyQuery.isFetching;

  const response = historyQuery.data;

  const responseItems = response?.items ?? response?.data;

  const histories = useMemo(
    () =>
      extractHistoryRecords({
        items: responseItems,
      }),
    [responseItems],
  );

  const pageInfoSource =
    response?.pageInfo ?? response?.meta?.pageInfo;

  const pageInfo = useMemo<NormalizedPageInfo>(() => {
    const nextCursor = normalizeCursor(
      pageInfoSource?.nextCursor ??
        pageInfoSource?.endCursor,
    );

    return {
      hasNextPage:
        Boolean(pageInfoSource?.hasNextPage) &&
        nextCursor !== null,
      hasPreviousPage:
        pagination.language === language &&
        pagination.cursorIndex > 0,
      nextCursor,
    };
  }, [
    language,
    pageInfoSource?.endCursor,
    pageInfoSource?.hasNextPage,
    pageInfoSource?.nextCursor,
    pagination.cursorIndex,
    pagination.language,
  ]);

  const error = historyQuery.error
    ? toSafeErrorMessage(
        t,
        historyQuery.error,
        "common.errors.generic",
      )
    : null;

  const handleSearchChange = useCallback(
    (value: string): void => {
      setSearchDraft(value);
    },
    [],
  );

  const onQueryChange = useCallback(
    (patch: unknown): void => {
      if (isRecord(patch) && "search" in patch) {
        const nextSearch = patch.search;

        if (nextSearch !== undefined) {
          setSearchDraft(String(nextSearch));
        }
      }

      const normalizedPatch =
        normalizeQueryPatch(patch);

      if (
        Object.keys(normalizedPatch).length === 0
      ) {
        return;
      }

      dispatch({ type: "PATCH_QUERY", patch: normalizedPatch });
    },
    [],
  );

  const onQueryClear = useCallback((): void => {
    setSearchDraft("");
    dispatch({ type: "CLEAR_QUERY" });
  }, []);

  const onNext = useCallback((): void => {
    const nextCursor = pageInfo.nextCursor;

    if (
      queryBusy ||
      !pageInfo.hasNextPage ||
      !nextCursor
    ) {
      return;
    }

    dispatch({ type: "GO_TO_NEXT_PAGE", nextCursor });
  }, [
    pageInfo.hasNextPage,
    pageInfo.nextCursor,
    queryBusy,
  ]);

  const onPrevious = useCallback((): void => {
    if (queryBusy) {
      return;
    }

    dispatch({ type: "GO_TO_PREVIOUS_PAGE" });
  }, [queryBusy]);

  const blockingError =
    Boolean(error) && histories.length === 0;

  const hasActiveFilters =
    Boolean(searchDraft.trim()) ||
    query.type !== DEFAULT_QUERY.type ||
    query.status !== DEFAULT_QUERY.status ||
    query.frequency !== DEFAULT_QUERY.frequency ||
    query.sortKey !== DEFAULT_QUERY.sortKey ||
    query.sortDirection !==
      DEFAULT_QUERY.sortDirection;

  return (
    <s-stack gap="base">
      {error ? (
        <s-banner
          heading={t("historyLoadError", {
            defaultValue:
              "History could not be loaded",
          })}
          tone="critical"
        >
          <s-paragraph>{error}</s-paragraph>
        </s-banner>
      ) : null}

      {!blockingError ? (
        <HistoryTable
          histories={histories}
          isLoading={queryBusy}
          pageInfo={pageInfo}
          query={query}
          querySearch={searchDraft}
          hasActiveFilters={hasActiveFilters}
          onSearchChange={handleSearchChange}
          onQueryChange={onQueryChange}
          onQueryClear={onQueryClear}
          onNext={onNext}
          onPrevious={onPrevious}
          emptyStateMessage={t("noHistory", {
            defaultValue:
              "No history items found.",
          })}
        />
      ) : null}
    </s-stack>
  );
}

export default HistoryComponent;
