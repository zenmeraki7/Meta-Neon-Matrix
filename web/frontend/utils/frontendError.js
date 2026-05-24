const GENERIC_ERROR_MESSAGE = "Request failed. Please try again.";

export function toSafeErrorMessage(error, fallback = GENERIC_ERROR_MESSAGE) {
  if (!error) return fallback;
  if (error.code === "REAUTH_REQUIRED") return "Your session expired. Please re-open the app from Shopify Admin.";
  if (error.status === 402) return "Plan limit reached. Upgrade your plan to continue.";
  if (error.status === 403) return "You do not have permission to perform this action.";
  if (error.status === 401) return "Authentication required. Please re-open the app.";

  const detailMessage =
    error?.details?.userMessage ||
    error?.details?.safeMessage ||
    error?.details?.message;
  if (detailMessage && typeof detailMessage === "string") return detailMessage;

  return fallback;
}
