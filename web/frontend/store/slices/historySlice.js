import { createSlice, createAsyncThunk, createAction } from "@reduxjs/toolkit";
import { historyService } from "../../Domain/History/services/historyService";
import { ExportHistoryResponseSchema } from "../../Domain/History/schema/exportHistorySchema";

let controller = null;

export const fetchHistories = createAsyncThunk(
  "history/fetchHistories",
  async (
    { type, cursor, limit, search, lang, status, frequency, sortKey, sortDirection },
    { rejectWithValue },
  ) => {
    try {
      if (controller) controller.abort();
      controller = new AbortController();

      if (type === "Recurring edit") {
        return await historyService.getRecurringEditHistories(
          { type, cursor, limit, search, lang, status, frequency, sortKey, sortDirection },
          controller.signal,
        );
      }

      return await historyService.getHistories(
        { type, cursor, limit, search, lang, status, frequency, sortKey, sortDirection },
        controller.signal,
      );
    } catch (error) {
      if (error.name === "AbortError") {
        return rejectWithValue("Request cancelled");
      }
      return rejectWithValue(error.message || "Failed to fetch histories");
    }
  },
);

export const fetchExportHistories = createAsyncThunk(
  "history/fetchExportHistories",
  async ({ lang }, { rejectWithValue }) => {
    try {
      if (controller) controller.abort();
      controller = new AbortController();

      const response = await historyService.getExportHistories({ lang });
      if (response && response.data) {
        const parsed = ExportHistoryResponseSchema.safeParse(response.data);
        if (!parsed.success) {
          const errorMessage = `Malformed API response: ${JSON.stringify(parsed.error.errors)}`;
          return rejectWithValue(errorMessage);
        }
        return { ...response, data: parsed.data };
      }
      return response;
    } catch (error) {
      if (error.name === "AbortError") {
        return rejectWithValue("Request cancelled");
      }
      return rejectWithValue(error.message || "Failed to fetch histories");
    }
  },
);

export const setExportHistoriesError = createAction("history/setExportHistoriesError");
export const clearExportHistories = createAction("history/clearExportHistories");

const initialState = {
  items: [],
  exportData: {
    histories: [],
    error: null,
    loading: false,
    validationError: null,
  },
  currentHistory: null,
  pageInfo: {
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
  },
  filters: {
    search: "",
    status: null,
    type: null,
  },
  limit: 50,
  cursor: null,
  loading: false,
  error: null,
  detailsStatus: "idle",
  detailsError: null,
};

const historySlice = createSlice({
  name: "history",
  initialState,
  reducers: {
    replacePage: (state, action) => {
      const payloadItems = Array.isArray(action.payload?.items)
        ? action.payload.items
        : [];
      state.items = payloadItems.slice(0, state.limit);
      state.pageInfo = {
        hasNextPage: Boolean(action.payload?.pageInfo?.hasNextPage),
        hasPreviousPage: Boolean(action.payload?.pageInfo?.hasPreviousPage),
        nextCursor: action.payload?.pageInfo?.nextCursor || null,
        previousCursor: action.payload?.pageInfo?.previousCursor || null,
      };
    },
    setFilters: (state, action) => {
      state.filters = {
        ...state.filters,
        ...action.payload,
      };
    },
    resetCursor: (state) => {
      state.cursor = null;
      state.pageInfo = {
        hasNextPage: false,
        hasPreviousPage: false,
        nextCursor: null,
        previousCursor: null,
      };
    },
    setCursor: (state, action) => {
      state.cursor = action.payload || null;
    },
    setSearchQuery: (state, action) => {
      state.filters.search = action.payload;
      state.cursor = null;
      state.items = [];
      state.pageInfo = {
        hasNextPage: false,
        hasPreviousPage: false,
        nextCursor: null,
        previousCursor: null,
      };
    },
    setHistoryType: (state, action) => {
      state.filters.type = action.payload;
      state.cursor = null;
      state.items = [];
      state.pageInfo = {
        hasNextPage: false,
        hasPreviousPage: false,
        nextCursor: null,
        previousCursor: null,
      };
    },
    setCursorFilters: (state, action) => {
      state.filters = { ...state.filters, ...action.payload };
      state.cursor = null;
      state.items = [];
      state.pageInfo = {
        hasNextPage: false,
        hasPreviousPage: false,
        nextCursor: null,
        previousCursor: null,
      };
    },
    clearCurrentHistory: (state) => {
      state.currentHistory = null;
      state.detailsStatus = "idle";
      state.detailsError = null;
    },
    clearExportData: (state) => {
      state.exportData = {
        histories: [],
        error: null,
        loading: false,
        validationError: null,
      };
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchHistories.pending, (state, action) => {
        if (!action.meta.arg.silent) state.loading = true;
        state.error = null;
      })
      .addCase(fetchHistories.fulfilled, (state, action) => {
        state.loading = false;
        const items = action.payload.items || action.payload.data || [];
        const pageInfo = action.payload.pageInfo || action.payload.meta?.pageInfo || {};
        state.items = Array.isArray(items) ? items.slice(0, state.limit) : [];
        state.pageInfo = {
          hasNextPage: Boolean(pageInfo.hasNextPage),
          hasPreviousPage: Boolean(pageInfo.hasPreviousPage),
          nextCursor: pageInfo.nextCursor || pageInfo.endCursor || null,
          previousCursor: pageInfo.previousCursor || null,
        };
        state.error = null;
      })
      .addCase(fetchHistories.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload || "Failed to fetch histories";
      })
      .addCase(fetchExportHistories.pending, (state) => {
        state.exportData.loading = true;
        state.exportData.error = null;
        state.exportData.validationError = null;
      })
      .addCase(fetchExportHistories.fulfilled, (state, action) => {
        state.exportData.loading = false;
        state.exportData.histories = action.payload.data || [];
        state.exportData.error = null;
        state.exportData.validationError = null;
      })
      .addCase(fetchExportHistories.rejected, (state, action) => {
        state.exportData.loading = false;
        state.exportData.histories = [];
        const errorMessage = action.payload || "Failed to fetch histories";
        if (errorMessage.includes("Malformed API response")) {
          state.exportData.validationError = errorMessage;
          state.exportData.error = null;
        } else {
          state.exportData.error = errorMessage;
          state.exportData.validationError = null;
        }
      })
      .addCase(setExportHistoriesError, (state, action) => {
        state.exportData.loading = false;
        state.exportData.error = action.payload;
      })
      .addCase(clearExportHistories, (state) => {
        state.exportData.histories = [];
        state.exportData.error = null;
        state.exportData.validationError = null;
      });
  },
});

export const {
  replacePage,
  setFilters,
  resetCursor,
  setCursor,
  setHistoryType,
  setSearchQuery,
  setCursorFilters,
  clearCurrentHistory,
  clearExportData,
} = historySlice.actions;

export const selectHistories = (state) => state.history.items;
export const selectExportData = (state) => state.history.exportData;
export const selectCurrentHistory = (state) => state.history.currentHistory;
export const selectHistoryPagination = (state) => ({
  ...state.history.pageInfo,
  limit: state.history.limit,
});
export const selectHistoryFilters = (state) => state.history.filters;
export const selectHistoryCursor = (state) => state.history.cursor;
export const selectHistoryStatus = (state) =>
  state.history.loading ? "loading" : "idle";
export const selectHistoryLoading = (state) => state.history.loading;
export const selectHistoryError = (state) => state.history.error;
export const selectHistoryDetailsStatus = (state) => state.history.detailsStatus;
export const selectHistoryDetailsError = (state) => state.history.detailsError;
export const selectExportValidationError = (state) => state.history.exportData.validationError;
export const selectExportHistories = (state) => state.history.exportData.histories;
export const selectExportLoading = (state) => state.history.exportData.loading;
export const selectExportError = (state) => state.history.exportData.error;

export default historySlice.reducer;
