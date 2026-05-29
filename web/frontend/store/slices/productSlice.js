// web/frontend/store/slices/productSlice.js
import { createEntityAdapter, createSelector, createSlice } from "@reduxjs/toolkit";

const productsAdapter = createEntityAdapter({
  selectId: (product) => String(product?.__rowId || product?.id || ""),
});

const initialState = {
  ...productsAdapter.getInitialState(),
  filters: [],
  search: "",
  filterHash: "[]",
  count: 0,
  pagination: null,
  cursor: null,
  cursorFilterHash: null,
};

const productSlice = createSlice({
  name: "products",
  initialState,
  reducers: {
    setProducts(state, action) {
      productsAdapter.setAll(state, Array.isArray(action.payload) ? action.payload : []);
    },

    setFilters(state, action) {
      state.filters = action.payload;
      state.cursor = null;
      state.cursorFilterHash = null;
    },

    clearFilters(state) {
      state.filters = [];
      state.search = "";
      state.filterHash = "[]";
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
      state.cursorFilterHash = action.payload ? state.filterHash : null;
    },

    applyFilterHashAndResetCursor(state, action) {
      const { filters = [], filterHash = "[]" } = action.payload || {};
      state.filters = filters;
      state.filterHash = filterHash;
      state.cursor = null;
      state.cursorFilterHash = null;
    },

    setCursorForFilterHash(state, action) {
      const { cursor = null, filterHash = state.filterHash } = action.payload || {};
      state.cursor = cursor;
      state.cursorFilterHash = cursor ? filterHash : null;
    },
  },
});

export const {
  setProducts,
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

const adapterSelectors = productsAdapter.getSelectors((state) => state.products);

export const selectProductIds = adapterSelectors.selectIds;
export const selectProductEntities = adapterSelectors.selectEntities;
export const selectProductById = adapterSelectors.selectById;
export const selectProducts = adapterSelectors.selectAll;
export const selectFilters = (state) => state.products.filters;
export const selectSearch = (state) => state.products.search;
export const selectProductCount = (state) => state.products.count;
export const selectPagination = (state) => state.products.pagination;
export const selectCursor = (state) => state.products.cursor;
export const selectFilterHash = (state) => state.products.filterHash;
export const selectCursorFilterHash = (state) => state.products.cursorFilterHash;

export const makeSelectProductRowViewModel = () =>
  createSelector(
    [
      (state, rowId) => selectProductById(state, rowId),
    ],
    (product) => {
      if (!product) return null;
      return {
        id: String(product.__rowId || product.id || ""),
        title: product.title ?? "",
        handle: product.handle ?? "",
        featuredImageUrl:
          product.featuredImageUrl ||
          product.featuredMedia?.preview?.image?.url ||
          "/images/fallback-2.png",
        status: product.status ?? null,
        totalInventory: product.totalInventory ?? "-",
        productType: product.productType || "-",
        vendor: product.vendor || "-",
      };
    },
  );
