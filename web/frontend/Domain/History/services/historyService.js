import { getAuthenticatedFetch } from "../../../api/authenticatedFetchRegistry";
import { toSafeErrorMessage } from "../../../utils/frontendError";

async function authRequest(url, options = {}) {
  const authFetch = getAuthenticatedFetch();
  if (!authFetch) throw new Error("Authenticated fetch is not initialized");
  const response = await authFetch(url, options);
  if (!response) throw new Error("Authentication required");

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const payload = isJson ? await response.json() : await response.blob();

  if (!response.ok) {
    const err = new Error(
      isJson ? payload?.message || payload?.error || "Request failed" : "Request failed",
    );
    err.status = response.status;
    err.details = payload;
    throw err;
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
      throw new Error(toSafeErrorMessage(error, "Failed to fetch history"));
    }
  },

  async getRecurringEditHistories(params, signal) {
    try {
      return await authRequest(`/api/products/get-recurring-edits?${buildQuery(params)}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(toSafeErrorMessage(error, "Failed to fetch recurring edits"));
    }
  },

  async getExportHistories({ lang, type, cursor, limit, search, sortKey, sortDirection }) {
    try {
      return await authRequest(
        `/api/history/get-shop-exporthistory?${buildQuery({
          lang: lang || "en",
          type,
          cursor,
          limit,
          search,
          sortKey,
          sortDirection,
        })}`,
        { method: "GET", headers: { "Content-Type": "application/json" } },
      );
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(toSafeErrorMessage(error, "Failed to fetch export history"));
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
        error: toSafeErrorMessage(error, "An unexpected error occurred during export."),
      };
    }
  },
};
