const GENERIC_ERROR_MESSAGE = "Request failed. Please try again.";

export function getStatusClass(status) {
  if (!Number.isFinite(Number(status))) {
    return "unknown";
  }

  const numeric = Number(status);
  if (numeric >= 500) return "5xx";
  if (numeric === 429) return "429";
  if (numeric === 422) return "422";
  if (numeric === 409) return "409";
  if (numeric === 403) return "403";
  if (numeric === 401) return "401";
  if (numeric >= 400) return "4xx";
  return "ok";
}

export function normalizeApiError(error, fallback = GENERIC_ERROR_MESSAGE) {
  const status = Number(error?.status || 0);
  const statusClass = getStatusClass(status);

  const detailMessage =
    error?.details?.userMessage ||
    error?.details?.safeMessage ||
    error?.details?.message ||
    error?.payload?.userMessage ||
    error?.payload?.safeMessage ||
    error?.payload?.message ||
    error?.message;

  const message = (() => {
    if (error?.code === "REAUTH_REQUIRED" || statusClass === "401") {
      return "Authentication required. Please re-open the app from Shopify Admin.";
    }
    if (status === 402) {
      return "Plan limit reached. Upgrade your plan to continue.";
    }
    if (statusClass === "403") {
      return "You do not have permission to perform this action.";
    }
    if (statusClass === "409") {
      return detailMessage || "Conflict detected. Refresh and try again.";
    }
    if (statusClass === "422") {
      return detailMessage || "Some inputs are invalid. Review the form and try again.";
    }
    if (statusClass === "429") {
      return "Too many requests. Please wait a moment and retry.";
    }
    if (statusClass === "5xx") {
      return "Server error. Please try again shortly.";
    }
    if (typeof detailMessage === "string" && detailMessage.trim()) {
      return detailMessage;
    }
    return fallback;
  })();

  return {
    message,
    status,
    statusClass,
  };
}

export function toSafeErrorMessage(error, fallback = GENERIC_ERROR_MESSAGE) {
  return normalizeApiError(error, fallback).message;
}
