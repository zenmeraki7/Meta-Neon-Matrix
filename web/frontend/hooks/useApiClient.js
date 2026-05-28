import { useCallback, useMemo } from "react";
import { useAuthenticatedFetch } from "./useAuthenticatedFetch";
import { unifiedApiRequest } from "../api/unifiedApiClient";

export function useApiClient() {
  const authFetch = useAuthenticatedFetch();

  const request = useCallback(
    (url, options = {}) => unifiedApiRequest(authFetch, url, options),
    [authFetch],
  );

  const get = useCallback(
    (url, options = {}) => request(url, { method: "GET", ...options }),
    [request],
  );

  const post = useCallback(
    (url, body, options = {}) => {
      const { headers: optionHeaders = {}, ...restOptions } = options;
      return request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...optionHeaders,
        },
        ...restOptions,
        body: body == null ? undefined : JSON.stringify(body),
      });
    },
    [request],
  );

  return useMemo(
    () => ({ request, get, post }),
    [request, get, post],
  );
}
