// src/hooks/useProducts.js
import { useState, useCallback, useRef, useEffect } from "react";
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
  const activeRequestRef = useRef({ id: 0, controller: null });

  const limit = 20;

  const fetchProducts = useCallback(
    async ({ cursor = null, filterParams = [] } = {}) => {
      if (activeRequestRef.current.controller) {
        activeRequestRef.current.controller.abort();
      }

      const controller = new AbortController();
      const requestId = activeRequestRef.current.id + 1;
      activeRequestRef.current = { id: requestId, controller };

      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        params.set("limit", String(limit));
        if (cursor) {
          params.set("cursor", cursor);
        }

        const json = await api.post(
          `/api/products/get-all?${params.toString()}`,
          { filterParams },
          { signal: controller.signal },
        );

        if (activeRequestRef.current.id !== requestId) {
          return;
        }

        const products = json?.data?.products || [];
        const pagination = json?.data?.pagination || null;
        const count = json?.data?.pagination?.total ?? products.length;

        dispatch(setProducts(products));
        dispatch(setCount(count));
        dispatch(setPagination(pagination));
        dispatch(setCursor(pagination?.nextCursor || null));
      } catch (err) {
        if (err?.name === "AbortError") {
          return;
        }
        setError(err.message);
      } finally {
        if (activeRequestRef.current.id !== requestId) {
          return;
        }
        setHasFetched(true);
        setLoading(false);
      }
    },
    [api, dispatch],
  );

  useEffect(() => {
    return () => {
      if (activeRequestRef.current.controller) {
        activeRequestRef.current.controller.abort();
      }
    };
  }, []);

  return {
    loading,
    error,
    hasFetched,
    fetchProducts,
  };
}
