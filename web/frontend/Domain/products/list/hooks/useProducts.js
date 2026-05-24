// src/hooks/useProducts.js
import { useState, useCallback } from "react";
import { useDispatch } from "react-redux";
import { useApiClient } from "../../../../hooks/useApiClient";
import {
  setProducts,
  setCount,
  setPagination,
  setCursor,
} from "../../../../store/slices/productSlice";

export default function useProducts() {
  const dispatch = useDispatch();
  const api = useApiClient();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasFetched, setHasFetched] = useState(false);

  const limit = 20;

  const fetchProducts = useCallback(
    async ({ cursor = null, filterParams = [] } = {}) => {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        params.set("limit", String(limit));
        if (cursor) {
          params.set("cursor", cursor);
        }

        const json = await api.post(`/api/products/get-all?${params.toString()}`, {
          filterParams,
        });

        const products = json?.data?.products || [];
        const pagination = json?.data?.pagination || null;
        const count = json?.data?.pagination?.total ?? products.length;

        dispatch(setProducts(products));
        dispatch(setCount(count));
        dispatch(setPagination(pagination));
        dispatch(setCursor(pagination?.nextCursor || null));
      } catch (err) {
        setError(err.message);
      } finally {
        setHasFetched(true);
        setLoading(false);
      }
    },
    [api, dispatch],
  );

  return {
    loading,
    error,
    hasFetched,
    fetchProducts,
  };
}
