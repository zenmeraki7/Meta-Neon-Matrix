const DEFAULT_ERROR_KEY = "common.errors.generic";
const ERROR_KEY_BY_CODE = Object.freeze({
  REAUTH_REQUIRED: "common.errors.code.REAUTH_REQUIRED",
  ENTITLEMENT_DENIED: "common.errors.code.ENTITLEMENT_DENIED",
  PLAN_LIMIT_REACHED: "common.errors.code.PLAN_LIMIT_REACHED",
  UPGRADE_REQUIRED: "common.errors.code.UPGRADE_REQUIRED",
  INVALID_INPUT: "common.errors.code.INVALID_INPUT",
  CONFLICT_DETECTED: "common.errors.code.CONFLICT_DETECTED",
});

const ERROR_KEY_BY_STATUS_CLASS = Object.freeze({
  "401": "common.errors.statusClass.401",
  "403": "common.errors.statusClass.403",
  "409": "common.errors.statusClass.409",
  "422": "common.errors.statusClass.422",
  "429": "common.errors.statusClass.429",
  "5xx": "common.errors.statusClass.5xx",
  "4xx": "common.errors.statusClass.4xx",
});

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

export function normalizeApiError(error, fallbackKey = DEFAULT_ERROR_KEY) {
  const status = Number(error?.status || 0);
  const statusClass = getStatusClass(status);
  const errorCode = String(
    error?.code ||
      error?.details?.code ||
      error?.payload?.code ||
      "",
  ).toUpperCase();

  const translationKey = (() => {
    if (ERROR_KEY_BY_CODE[errorCode]) {
      return ERROR_KEY_BY_CODE[errorCode];
    }
    if (status === 402) {
      return "common.errors.code.PLAN_LIMIT_REACHED";
    }
    if (ERROR_KEY_BY_STATUS_CLASS[statusClass]) {
      return ERROR_KEY_BY_STATUS_CLASS[statusClass];
    }
    return fallbackKey;
  })();

  return {
    translationKey,
    status,
    statusClass,
    errorCode,
  };
}

export function toSafeErrorMessage(arg1, arg2, arg3 = DEFAULT_ERROR_KEY) {
  const isTranslator = typeof arg1 === "function";

  if (isTranslator) {
    const t = arg1;
    const error = arg2;
    const fallbackKey = arg3 || DEFAULT_ERROR_KEY;
    const normalized = normalizeApiError(error, fallbackKey);
    return t(normalized.translationKey, {
      defaultValue: t(fallbackKey, {
        defaultValue: "Request failed. Please try again.",
      }),
    });
  }

  const error = arg1;
  const fallbackMessage =
    typeof arg2 === "string" && arg2.trim()
      ? arg2
      : "Request failed. Please try again.";
  const normalized = normalizeApiError(error, DEFAULT_ERROR_KEY);
  const fallbackByClass = {
    "401": "Authentication required. Please re-open the app from Shopify Admin.",
    "403": "You do not have permission to perform this action.",
    "409": "Conflict detected. Refresh and try again.",
    "422": "Some inputs are invalid. Review the form and try again.",
    "429": "Too many requests. Please wait a moment and retry.",
    "5xx": "Server error. Please try again shortly.",
    "4xx": fallbackMessage,
  };
  return fallbackByClass[normalized.statusClass] || fallbackMessage;
}
