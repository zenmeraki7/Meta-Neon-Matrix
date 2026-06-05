import { generateErrorId } from "./errorUtils.js";

const DEFAULT_MESSAGES = Object.freeze({
  UNAUTHENTICATED: "Authentication required.",
  UNAUTHORIZED: "Authentication required.",
  FORBIDDEN: "You are not allowed to perform this action",
  CONFLICT: "Operation cannot be completed in the current state",
  VALIDATION_FAILED: "Request validation failed",
  NOT_FOUND: "Requested resource was not found",
  RATE_LIMITED: "Too many requests. Please retry shortly",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again later.",
});

function statusFromCode(code = "INTERNAL_ERROR") {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "UNAUTHORIZED") return 403;
  if (code === "FORBIDDEN") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "RATE_LIMITED") return 429;
  if (code === "VALIDATION_FAILED") return 400;
  return 500;
}

function codeFromStatusCode(statusCode) {
  if (statusCode === 400) return "VALIDATION_FAILED";
  if (statusCode === 401) return "UNAUTHENTICATED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 429) return "RATE_LIMITED";
  return null;
}

function normalizeStatusCode(value) {
  const statusCode = Number(value);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : null;
}

export function mapErrorToPublicContract(error, fallbackCode = "INTERNAL_ERROR") {
  const raw = String(error?.code || "").toUpperCase();

  if (raw.includes("UNAUTHORIZED") || raw.includes("UNAUTHENTICATED")) {
    return { code: "UNAUTHENTICATED", message: DEFAULT_MESSAGES.UNAUTHENTICATED };
  }
  if (raw.includes("NOT_FOUND")) {
    return { code: "NOT_FOUND", message: DEFAULT_MESSAGES.NOT_FOUND };
  }
  if (
    raw.includes("PREMIUM_FEATURE_REQUIRED") ||
    raw.includes("PLAN_UPGRADE_REQUIRED") ||
    raw.includes("FORBIDDEN")
  ) {
    return { code: "FORBIDDEN", message: DEFAULT_MESSAGES.FORBIDDEN };
  }
  if (
    raw.includes("STALE")
    || raw.includes("MISMATCH")
    || raw.includes("ALREADY")
    || raw.includes("NOT_OPEN")
    || raw.includes("CANCEL_NOT_ALLOWED")
    || raw.includes("CONFLICT")
  ) {
    return { code: "CONFLICT", message: DEFAULT_MESSAGES.CONFLICT };
  }
  if (
    raw.includes("INVALID")
    || raw.includes("REQUIRED")
    || raw.includes("FAILED")
    || raw.includes("MISSING")
    || raw.includes("LIMIT")
  ) {
    return { code: "VALIDATION_FAILED", message: DEFAULT_MESSAGES.VALIDATION_FAILED };
  }

  const statusCode = normalizeStatusCode(error?.statusCode);
  const statusCodeContract = codeFromStatusCode(statusCode);
  if (statusCodeContract) {
    return {
      code: statusCodeContract,
      message: DEFAULT_MESSAGES[statusCodeContract] || DEFAULT_MESSAGES.INTERNAL_ERROR,
    };
  }

  const fallback = String(fallbackCode || "INTERNAL_ERROR").toUpperCase();
  return {
    code: fallback,
    message: DEFAULT_MESSAGES[fallback] || DEFAULT_MESSAGES.INTERNAL_ERROR,
  };
}

export function buildPublicApiErrorResponse(error, fallbackCode = "INTERNAL_ERROR") {
  const mapped = mapErrorToPublicContract(error, fallbackCode);
  const statusCode = statusFromCode(mapped.code);
  const body = {
    success: false,
    code: mapped.code,
    message: mapped.message,
    errorId: generateErrorId(),
  };

  if (
    mapped.code === "VALIDATION_FAILED" &&
    Array.isArray(error?.fields) &&
    error.fields.length > 0
  ) {
    body.fields = error.fields;
  }

  return {
    statusCode,
    body,
  };
}
