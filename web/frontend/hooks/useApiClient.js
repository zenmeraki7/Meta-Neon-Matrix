import { useCallback, useMemo } from "react";
import { useAuthenticatedFetch } from "./useAuthenticatedFetch";
import { generateIdempotencyKey } from "../utils/idempotencyKey";
import { normalizeApiError } from "../utils/frontendError";
import { shouldDefaultIdempotent } from "../api/idempotencyDefaults";

function buildError(message, status, code, details) {
  const error = new Error(message || "Request failed");
  error.status = status;
  error.code = code || "REQUEST_FAILED";
  error.details = details;
  error.statusClass = normalizeApiError(error).statusClass;
  return error;
}

export function useApiClient() {
  const authFetch = useAuthenticatedFetch();

  const request = useCallback(
    async (url, options = {}) => {
      const method = String(options?.method || "GET").toUpperCase();
      const headers = { ...(options?.headers || {}) };
      const hasIdempotencyKey = Boolean(headers["Idempotency-Key"]);
      if (
        shouldDefaultIdempotent(method, url) &&
        !hasIdempotencyKey
      ) {
        headers["Idempotency-Key"] = generateIdempotencyKey();
      }

      const response = await authFetch(url, {
        ...options,
        method,
        headers,
      });
      if (!response) {
        throw buildError("Reauthentication required", 401, "REAUTH_REQUIRED");
      }

      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");
      const payload = isJson ? await response.json() : await response.text();

      if (!response.ok) {
        if (isJson && payload && typeof payload === "object") {
          const error = buildError(
            payload.message || payload.error || "Request failed",
            response.status,
            payload.code,
            payload,
          );
          const normalized = normalizeApiError(error, error.message);
          error.message = normalized.message;
          error.statusClass = normalized.statusClass;
          throw error;
        }
        const error = buildError(String(payload || "Request failed"), response.status);
        const normalized = normalizeApiError(error, error.message);
        error.message = normalized.message;
        error.statusClass = normalized.statusClass;
        throw error;
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
    (url, body, options = {}) => {
      const { idempotent = false, idempotencyKey = null, headers = {}, ...rest } = options;
      const shouldAttachIdempotencyHeader =
        idempotent || shouldDefaultIdempotent("POST", url);
      return request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(shouldAttachIdempotencyHeader
            ? { "Idempotency-Key": idempotencyKey || generateIdempotencyKey() }
            : {}),
          ...headers,
        },
        ...rest,
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
