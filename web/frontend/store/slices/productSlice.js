// web/frontend/store/slices/productSlice.js
import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  filters: [],
  search: "",
  normalizedFilterHash: "[]",
  count: 0,
  pagination: null,
  cursor: null,
  cursorFilterHash: null,
};

const productSlice = createSlice({
  name: "products",
  initialState,
  reducers: {
    setFilters(state, action) {
      state.filters = action.payload;
      state.cursor = null;
      state.cursorFilterHash = null;
    },

    clearFilters(state) {
      state.filters = [];
      state.search = "";
      state.normalizedFilterHash = "[]";
      state.cursor = null;
      state.cursorFilterHash = null;
    },

    setSearch(state, action) {
      state.search = action.payload;
      state.cursor = null;
      state.cursorFilterHash = null;
    },

    setCount(state, action) {
      state.count = action.payload;
    },

    setPagination(state, action) {
      state.pagination = action.payload;
    },

    setCursor(state, action) {
      state.cursor = action.payload;
      state.cursorFilterHash = action.payload ? state.normalizedFilterHash : null;
    },

    applyFilterHashAndResetCursor(state, action) {
      const { filters = [], normalizedFilterHash = "[]" } = action.payload || {};
      state.filters = filters;
      state.normalizedFilterHash = normalizedFilterHash;
      state.cursor = null;
      state.cursorFilterHash = null;
    },

    setCursorForFilterHash(state, action) {
      const { cursor = null, normalizedFilterHash = state.normalizedFilterHash } = action.payload || {};
      state.cursor = cursor;
      state.cursorFilterHash = cursor ? normalizedFilterHash : null;
    },
  },
});

export const {
  setFilters,
  clearFilters,
  setSearch,
  setCount,
  setPagination,
  setCursor,
  applyFilterHashAndResetCursor,
  setCursorForFilterHash,
} = productSlice.actions;

export default productSlice.reducer;

export const selectFilters = (state) => state.products.filters;
export const selectSearch = (state) => state.products.search;
export const selectProductCount = (state) => state.products.count;
export const selectPagination = (state) => state.products.pagination;
export const selectCursor = (state) => state.products.cursor;
export const selectFilterHash = (state) => state.products.normalizedFilterHash;
export const selectCursorFilterHash = (state) => state.products.cursorFilterHash;
