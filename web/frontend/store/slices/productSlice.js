// web/frontend/store/slices/productSlice.js
import { createSlice } from "@reduxjs/toolkit";

const initialState = {
  products: [],
  filters: [],
  search: "",
  count: 0,
  pagination: null,
  cursor: null,
};

const productSlice = createSlice({
  name: "products",
  initialState,
  reducers: {
    setProducts(state, action) {
      state.products = action.payload;
    },

    setFilters(state, action) {
      state.filters = action.payload;
      state.cursor = null;
    },

    clearFilters(state) {
      state.filters = [];
      state.search = "";
      state.cursor = null;
    },

    setSearch(state, action) {
      state.search = action.payload;
      state.cursor = null;
    },

    setCount(state, action) {
      state.count = action.payload;
    },

    setPagination(state, action) {
      state.pagination = action.payload;
    },

    setCursor(state, action) {
      state.cursor = action.payload;
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
} = productSlice.actions;

export default productSlice.reducer;

export const selectProducts = (state) => state.products.products;
export const selectFilters = (state) => state.products.filters;
export const selectSearch = (state) => state.products.search;
export const selectProductCount = (state) => state.products.count;
export const selectPagination = (state) => state.products.pagination;
export const selectCursor = (state) => state.products.cursor;
