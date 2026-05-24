import { generateErrorId } from "./errorUtils.js";

const DEFAULT_MESSAGES = Object.freeze({
  UNAUTHORIZED: "Session expired",
  FORBIDDEN: "You are not allowed to perform this action",
  CONFLICT: "Operation cannot be completed in the current state",
  VALIDATION_FAILED: "Request validation failed",
  NOT_FOUND: "Requested resource was not found",
  RATE_LIMITED: "Too many requests. Please retry shortly",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again later.",
});

function statusFromCode(code = "INTERNAL_ERROR") {
  if (code === "UNAUTHORIZED") return 403;
  if (code === "FORBIDDEN") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "RATE_LIMITED") return 429;
  if (code === "VALIDATION_FAILED") return 400;
  return 500;
}

export function mapErrorToPublicContract(error, fallbackCode = "INTERNAL_ERROR") {
  const raw = String(error?.code || "").toUpperCase();

  if (raw.includes("SESSION") || raw.includes("UNAUTHORIZED")) {
    return { code: "UNAUTHORIZED", message: DEFAULT_MESSAGES.UNAUTHORIZED };
  }
  if (raw.includes("NOT_FOUND")) {
    return { code: "NOT_FOUND", message: DEFAULT_MESSAGES.NOT_FOUND };
  }
  if (raw.includes("PREMIUM_FEATURE_REQUIRED") || raw.includes("FORBIDDEN")) {
    return { code: "FORBIDDEN", message: DEFAULT_MESSAGES.FORBIDDEN };
  }
  if (
    raw.includes("STALE")
    || raw.includes("MISMATCH")
    || raw.includes("ALREADY")
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

  const fallback = String(fallbackCode || "INTERNAL_ERROR").toUpperCase();
  return {
    code: fallback,
    message: DEFAULT_MESSAGES[fallback] || DEFAULT_MESSAGES.INTERNAL_ERROR,
  };
}

export function buildPublicApiErrorResponse(error, fallbackCode = "INTERNAL_ERROR") {
  const mapped = mapErrorToPublicContract(error, fallbackCode);
  const statusCode = statusFromCode(mapped.code);
  return {
    statusCode,
    body: {
      success: false,
      code: mapped.code,
      message: mapped.message,
      errorId: generateErrorId(),
    },
  };
}

