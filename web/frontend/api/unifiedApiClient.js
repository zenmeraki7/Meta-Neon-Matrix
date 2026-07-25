import { generateIdempotencyKey } from "../utils/idempotencyKey";
import { normalizeApiError } from "../utils/frontendError";
import { shouldDefaultIdempotent } from "./idempotencyDefaults";
import { triggerGlobalReauth } from "./reauthHandler";

function buildApiError(message, status, payload, code) {
  const error = new Error(message || "Request failed");
  error.status = status || 0;
  error.payload = payload ?? null;
  error.details = payload ?? null;
  error.code = code || payload?.code || "REQUEST_FAILED";
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

export async function unifiedApiRequest(authFetch, path, options = {}) {
  const {
    idempotent = false,
    idempotencyKey = null,
    headers: inputHeaders = {},
    ...requestOptions
  } = options;

  if (typeof authFetch !== "function") {
    throw buildApiError(
      "Authenticated fetch is not initialized. Reload the embedded app.",
      401,
      null,
      "AUTH_FETCH_UNAVAILABLE",
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
      method,
      headers,
    });
  } catch (error) {
    if (error?.code === "REAUTH_REQUIRED") {
      triggerGlobalReauth(error?.redirectUrl);
      throw buildApiError(
        "Reauthorization required",
        401,
        { code: "REAUTH_REQUIRED" },
        "REAUTH_REQUIRED",
      );
    }
    throw error;
  }

  if (!response) {
    throw buildApiError("Reauthentication required", 401, null, "REAUTH_REQUIRED");
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
