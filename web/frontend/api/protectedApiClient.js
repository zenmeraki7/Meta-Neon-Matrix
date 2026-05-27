import { getAuthenticatedFetch } from "./authenticatedFetchRegistry";
import { isReauthInProgress, triggerGlobalReauth } from "./reauthHandler";
import { generateIdempotencyKey } from "../utils/idempotencyKey";
import { normalizeApiError } from "../utils/frontendError";
import { shouldDefaultIdempotent } from "./idempotencyDefaults";

function buildApiError(message, status, payload) {
  const error = new Error(message || "Request failed");
  error.status = status || 0;
  error.payload = payload ?? null;
  error.details = payload ?? null;
  error.statusClass = normalizeApiError(error).statusClass;
  return error;
}

async function parsePayload(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function protectedApiRequest(path, options = {}) {
  const {
    idempotent = false,
    idempotencyKey = null,
    headers: inputHeaders = {},
    ...requestOptions
  } = options;

  const authFetch = getAuthenticatedFetch();
  if (isReauthInProgress()) {
    throw buildApiError("Reauthentication in progress", 401);
  }

  if (typeof authFetch !== "function") {
    throw buildApiError(
      "Authenticated fetch is not initialized. Reload the embedded app.",
      401,
    );
  }

  let response;
  try {
    const method = String(requestOptions.method || "GET").toUpperCase();
    const shouldAttachIdempotencyHeader =
      idempotent || shouldDefaultIdempotent(method, path);
    const headers = { ...inputHeaders };
    if (shouldAttachIdempotencyHeader && !headers["Idempotency-Key"]) {
      headers["Idempotency-Key"] = idempotencyKey || generateIdempotencyKey();
    }

    response = await authFetch(path, {
      ...requestOptions,
      headers,
    });
  } catch (error) {
    if (error?.code === "REAUTH_REQUIRED") {
      triggerGlobalReauth(error?.redirectUrl);
      throw buildApiError("Reauthorization required", 401, {
        code: "REAUTH_REQUIRED",
      });
    }
    throw error;
  }
  const payload = await parsePayload(response);

  if (!response.ok) {
    const message =
      typeof payload === "object" && payload
        ? payload.message || payload.error || "Request failed"
        : String(payload || "Request failed");
    const apiError = buildApiError(message, response.status, payload);
    const normalized = normalizeApiError(apiError, message);
    apiError.message = normalized.message;
    apiError.statusClass = normalized.statusClass;
    throw apiError;
  }

  return payload;
}

export function protectedApiGet(path, options = {}) {
  return protectedApiRequest(path, { method: "GET", ...options });
}

export function protectedApiDelete(path, options = {}) {
  return protectedApiRequest(path, { method: "DELETE", ...options });
}

export function protectedApiPost(path, body, options = {}) {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...optionHeaders },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function protectedApiPut(path, body, options = {}) {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...optionHeaders },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function protectedApiPatch(path, body, options = {}) {
  const { headers: optionHeaders = {}, ...restOptions } = options;
  return protectedApiRequest(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...optionHeaders },
    ...restOptions,
    body: body == null ? undefined : JSON.stringify(body),
  });
}
