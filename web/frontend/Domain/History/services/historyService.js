import { getAuthenticatedFetch } from "../../../api/authenticatedFetchRegistry";
import { toSafeErrorMessage } from "../../../utils/frontendError";

async function authRequest(url, options = {}) {
  const authFetch = getAuthenticatedFetch();
  if (!authFetch) {
    throw new Error("Authenticated fetch is not initialized");
  }
  const response = await authFetch(url, options);
  if (!response) {
    throw new Error("Authentication required");
  }

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

export const historyService = {
  async getHistories(type, cursor, limit, search, signal, lang) {
    const queryParams = new URLSearchParams();
    if (type) queryParams.append("type", type);
    if (limit) queryParams.append("limit", limit);
    if (search) queryParams.append("search", search);
    if (lang) queryParams.append("lang", lang);
    if (cursor && typeof cursor === "string" && cursor.trim() !== "") {
      queryParams.append("cursor", cursor);
    }

    try {
      return await authRequest(`/api/history/get-shop-edithistory?${queryParams.toString()}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(toSafeErrorMessage(error, "Failed to fetch history"));
    }
  },

  async getRecurringEditHistories(type, cursor, limit, search, signal, lang) {
    const queryParams = new URLSearchParams();
    if (type) queryParams.append("type", type);
    if (limit) queryParams.append("limit", limit);
    if (search) queryParams.append("search", search);
    if (lang) queryParams.append("lang", lang);
    if (cursor && typeof cursor === "string" && cursor.trim() !== "") {
      queryParams.append("cursor", cursor);
    }

    try {
      return await authRequest(`/api/products/get-recurring-edits?${queryParams.toString()}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(toSafeErrorMessage(error, "Failed to fetch recurring edits"));
    }
  },

  async getExportHistories({ lang }) {
    const queryParams = new URLSearchParams();
    queryParams.append("lang", lang || "en");

    try {
      return await authRequest(`/api/history/get-shop-exporthistory?${queryParams.toString()}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(toSafeErrorMessage(error, "Failed to fetch export history"));
    }
  },

  async downloadExportedData(id, fileName = "exported_data") {
    try {
      const blob = await authRequest(`/api/products/download-export/${id}`, {
        method: "GET",
      });
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

