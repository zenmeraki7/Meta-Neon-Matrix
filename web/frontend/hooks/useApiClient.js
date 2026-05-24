import { useCallback } from "react";
import { useAuthenticatedFetch } from "./useAuthenticatedFetch";

function buildError(message, status, code, details) {
  const error = new Error(message || "Request failed");
  error.status = status;
  error.code = code || "REQUEST_FAILED";
  error.details = details;
  return error;
}

export function useApiClient() {
  const authFetch = useAuthenticatedFetch();

  const request = useCallback(
    async (url, options = {}) => {
      const response = await authFetch(url, options);
      if (!response) {
        throw buildError("Reauthentication required", 401, "REAUTH_REQUIRED");
      }

      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");
      const payload = isJson ? await response.json() : await response.text();

      if (!response.ok) {
        if (isJson && payload && typeof payload === "object") {
          throw buildError(
            payload.message || payload.error || "Request failed",
            response.status,
            payload.code,
            payload,
          );
        }
        throw buildError(String(payload || "Request failed"), response.status);
      }

      return payload;
    },
    [authFetch],
  );

  const get = useCallback(
    (url, options = {}) => request(url, { method: "GET", ...options }),
    [request],
  );

  const post = useCallback(
    (url, body, options = {}) =>
      request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        ...options,
        body: body == null ? undefined : JSON.stringify(body),
      }),
    [request],
  );

  return { request, get, post };
}

