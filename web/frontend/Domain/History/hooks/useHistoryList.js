import { useEffect, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  fetchHistories,
  setHistoryType,
  setFilters as setHistoryFilters,
  resetCursor,
  setCursor,
  selectHistories,
  selectHistoryPagination,
  selectHistoryFilters,
  selectHistoryCursor,
  selectHistoryLoading,
  selectHistoryError,
} from "../../../store/slices/historySlice";
import { useTranslation } from "react-i18next";
import { toSafeErrorMessage } from "../../../utils/frontendError";

export const TYPE_TO_KEY = {
  "Manual edit": "ManualEdit",
  "Scheduled edit": "ScheduledEdit",
  "Recurring edit": "RecurringEdit",
  Favorites: "Favorites",
};

export const KEY_TO_TYPE = {
  ManualEdit: "Manual edit",
  ScheduledEdit: "Scheduled edit",
  RecurringEdit: "Recurring edit",
  Favorites: "Favorites",
};

const TAB_ID_TO_BACKEND_TYPE = {
  ManualEdit: "Manual edit",
  ScheduledEdit: "Scheduled edit",
  RecurringEdit: "Recurring edit",
  Favorites: "Favorites",
};

export const useHistoryList = () => {
  const dispatch = useDispatch();
  const { i18n, t } = useTranslation();

  const histories = useSelector(selectHistories);
  const pagination = useSelector(selectHistoryPagination);
  const filters = useSelector(selectHistoryFilters);
  const cursor = useSelector(selectHistoryCursor);
  const loading = useSelector(selectHistoryLoading);
  const error = useSelector(selectHistoryError);
  const localizedError = error
    ? toSafeErrorMessage(t, error, "common.errors.generic")
    : null;

  const isLoading = loading;

  const fetchHistoryData = useCallback(
    ({ nextCursor = cursor, silent = false } = {}) => {
      dispatch(
        fetchHistories({
          ...filters,
          cursor: nextCursor,
          limit: pagination.limit,
          lang: i18n.language || "en",
          silent,
        }),
      );
    },
    [cursor, dispatch, filters, pagination.limit, i18n.language],
  );

  const handleTabChange = useCallback(
    (tabIndex, tabTypes) => {
      const selectedTab = tabTypes[tabIndex];
      const backendValue =
        selectedTab?.backendValue ||
        selectedTab?.value ||
        TAB_ID_TO_BACKEND_TYPE[selectedTab?.id] ||
        "Manual edit";
      dispatch(setHistoryType(backendValue));
    },
    [dispatch],
  );

  const applyFilters = useCallback(
    (nextFilters) => {
      dispatch(setHistoryFilters(nextFilters));
      dispatch(resetCursor());
    },
    [dispatch],
  );

  const goNext = useCallback(() => {
    if (pagination.hasNextPage && pagination.nextCursor) {
      dispatch(setCursor(pagination.nextCursor));
    }
  }, [dispatch, pagination.hasNextPage, pagination.nextCursor]);

  const goPrevious = useCallback(() => {
    if (pagination.hasPreviousPage && pagination.previousCursor) {
      dispatch(setCursor(pagination.previousCursor));
    }
  }, [dispatch, pagination.hasPreviousPage, pagination.previousCursor]);

  useEffect(() => {
    fetchHistoryData();
  }, [fetchHistoryData, filters.type, filters.search, filters.status, pagination.limit, cursor]);

  useEffect(() => {
    const hasActiveItems = histories.some((h) => {
      const mainActive = ["pending", "processing"].includes(String(h.status || "").toLowerCase());
      const undoActive = ["processing"].includes(String(h.undo?.status || "").toLowerCase());
      return mainActive || undoActive;
    });

    if (!hasActiveItems) return;

    const interval = setInterval(() => {
      fetchHistoryData({ silent: true });
    }, 4000);

    return () => clearInterval(interval);
  }, [histories, fetchHistoryData]);

  return {
    histories,
    pagination,
    filters,
    isLoading,
    error: localizedError,
    rawError: error,
    handleTabChange,
    refetch: fetchHistoryData,
    setFilters: applyFilters,
    goNext,
    goPrevious,
  };
};
