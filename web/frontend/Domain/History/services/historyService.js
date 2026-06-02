import { getAuthenticatedFetch } from "../../../api/authenticatedFetchRegistry";

function toServiceError(error, fallbackCode) {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(
    error?.code ||
      error?.details?.code ||
      error?.payload?.code ||
      fallbackCode ||
      "REQUEST_FAILED",
  ).toUpperCase();

  const serviceError = new Error(code);
  serviceError.name = "ServiceError";
  serviceError.code = code;
  serviceError.status = Number.isFinite(status) && status > 0 ? status : undefined;
  serviceError.details =
    error?.details ||
    error?.payload ||
    error?.response?.data ||
    null;
  serviceError.cause = error;

  return serviceError;
}

async function authRequest(url, options = {}) {
  const authFetch = getAuthenticatedFetch();
  if (!authFetch) {
    throw toServiceError(
      { code: "AUTH_FETCH_UNINITIALIZED", status: 401 },
      "AUTH_FETCH_UNINITIALIZED",
    );
  }
  const response = await authFetch(url, options);
  if (!response) {
    throw toServiceError({ code: "UNAUTHENTICATED", status: 401 }, "UNAUTHENTICATED");
  }

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json() : await response.blob();

  if (!response.ok) {
    throw toServiceError(
      {
        code: payload?.code || payload?.errorCode || "HTTP_REQUEST_FAILED",
        status: response.status,
        details: payload,
      },
      "HTTP_REQUEST_FAILED",
    );
  }

  return payload;
}

function buildQuery(params = {}) {
  const queryParams = new URLSearchParams();
  const allowed = [
    "type",
    "cursor",
    "limit",
    "search",
    "lang",
    "status",
    "frequency",
    "sortKey",
    "sortDirection",
  ];

  for (const key of allowed) {
    const value = params[key];
    if (value == null || value === "") continue;
    queryParams.append(key, String(value));
  }

  return queryParams.toString();
}

export const historyService = {
  async getHistories(params, signal) {
    try {
      return await authRequest(`/api/history/get-shop-edithistory?${buildQuery(params)}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw toServiceError(error, "HISTORY_LIST_FETCH_FAILED");
    }
  },

  async getRecurringEditHistories(params, signal) {
    try {
      return await authRequest(`/api/products/recurring/list-summary?${buildQuery(params)}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw toServiceError(error, "RECURRING_HISTORY_FETCH_FAILED");
    }
  },

  async getExportHistories({ lang, type, cursor, limit, search, sortKey, sortDirection }, signal) {
    try {
      return await authRequest(
        `/api/history/export/list-summary?${buildQuery({
          lang: lang || "en",
          type,
          cursor,
          limit,
          search,
          sortKey,
          sortDirection,
        })}`,
        { method: "GET", headers: { "Content-Type": "application/json" }, signal },
      );
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw toServiceError(error, "EXPORT_HISTORY_FETCH_FAILED");
    }
  },

  async downloadExportedData(id, fileName = "exported_data") {
    try {
      const blob = await authRequest(`/api/products/download-export/${id}`, { method: "GET" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${fileName}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: toServiceError(error, "EXPORT_DOWNLOAD_FAILED"),
      };
    }
  },
};
