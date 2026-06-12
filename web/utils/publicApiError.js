import { generateErrorId } from "./errorUtils.js";

const DEFAULT_MESSAGES = Object.freeze({
  UNAUTHENTICATED: "Authentication required.",
  UNAUTHORIZED: "Authentication required.",
  FORBIDDEN: "You are not allowed to perform this action",
  CONFLICT: "Operation cannot be completed in the current state",
  VALIDATION_FAILED: "Request validation failed",
  NOT_FOUND: "Requested resource was not found",
  RATE_LIMITED: "Too many requests. Please retry shortly",
  TARGETING_REQUIRES_SYNC: "Refresh product data before previewing this edit.",
  TARGETING_FILTER_UNSUPPORTED: "This filter cannot be previewed safely. Refresh products or simplify the filter.",
  PREVIEW_NOT_FOUND: "Run preview again before applying this edit.",
  PREVIEW_FORBIDDEN: "This preview does not belong to the current shop.",
  PREVIEW_STALE: "Preview is stale. Run preview again before applying this edit.",
  PREVIEW_SNAPSHOT_INCOMPLETE: "Preview data is incomplete. Run preview again before applying this edit.",
  EDIT_EXECUTION_FAILED: "Unable to start this edit. Run preview again and retry.",
  EDIT_PREVIEW_FAILED: "Unable to generate edit preview.",
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
  if (code === "TARGETING_REQUIRES_SYNC") return 409;
  if (code === "TARGETING_FILTER_UNSUPPORTED") return 422;
  if (code === "PREVIEW_NOT_FOUND") return 404;
  if (code === "PREVIEW_FORBIDDEN") return 403;
  if (code === "PREVIEW_STALE") return 409;
  if (code === "PREVIEW_SNAPSHOT_INCOMPLETE") return 409;
  if (code === "EDIT_EXECUTION_FAILED") return 500;
  return 500;
}

export function mapErrorToPublicContract(error, fallbackCode = "INTERNAL_ERROR") {
  const raw = String(error?.code || error?.message || "").toUpperCase();

  if (raw.includes("SESSION") || raw.includes("UNAUTHORIZED") || raw.includes("UNAUTHENTICATED")) {
    return { code: "UNAUTHENTICATED", message: DEFAULT_MESSAGES.UNAUTHENTICATED };
  }
  if (raw.includes("NOT_FOUND")) {
    return { code: "NOT_FOUND", message: DEFAULT_MESSAGES.NOT_FOUND };
  }
  if (raw === "TARGETING_MIRROR_UNSAFE" || raw === "TARGETING_REQUIRES_SYNC") {
    return {
      code: "TARGETING_REQUIRES_SYNC",
      message: DEFAULT_MESSAGES.TARGETING_REQUIRES_SYNC,
    };
  }
  if (raw === "TARGETING_FILTER_UNSUPPORTED" || raw === "UNSUPPORTED_CONTEXT") {
    return {
      code: "TARGETING_FILTER_UNSUPPORTED",
      message: DEFAULT_MESSAGES.TARGETING_FILTER_UNSUPPORTED,
    };
  }
  if (raw === "PREVIEW_NOT_FOUND") {
    return {
      code: "PREVIEW_NOT_FOUND",
      message: DEFAULT_MESSAGES.PREVIEW_NOT_FOUND,
    };
  }
  if (raw === "PREVIEW_FORBIDDEN") {
    return {
      code: "PREVIEW_FORBIDDEN",
      message: DEFAULT_MESSAGES.PREVIEW_FORBIDDEN,
    };
  }
  if (raw === "PREVIEW_EXPIRED" || raw === "PREVIEW_STALE") {
    return {
      code: "PREVIEW_STALE",
      message: DEFAULT_MESSAGES.PREVIEW_STALE,
    };
  }
  if (raw === "PREVIEW_SNAPSHOT_INCOMPLETE") {
    return {
      code: "PREVIEW_SNAPSHOT_INCOMPLETE",
      message: DEFAULT_MESSAGES.PREVIEW_SNAPSHOT_INCOMPLETE,
    };
  }
  if (
    raw === "PREVIEW_OWNERSHIP_UNBOUND"
    || raw === "ACTOR_ID_REQUIRED_FOR_EXECUTE"
    || raw === "PREVIEW_ACTOR_MISMATCH"
  ) {
    return {
      code: "EDIT_EXECUTION_FAILED",
      message: DEFAULT_MESSAGES.EDIT_EXECUTION_FAILED,
    };
  }
  if (raw === "EDIT_PREVIEW_FAILED") {
    return {
      code: "EDIT_PREVIEW_FAILED",
      message: DEFAULT_MESSAGES.EDIT_PREVIEW_FAILED,
    };
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
  const fields = Array.isArray(error?.fields) ? error.fields : [];
  const errors = fields.reduce((acc, fieldError) => {
    const field = String(fieldError?.field || "body").trim() || "body";
    const message = String(fieldError?.error || fieldError?.message || mapped.message).trim();
    acc[field] = message || mapped.message;
    return acc;
  }, {});
  if (
    mapped.code === "VALIDATION_FAILED" &&
    Object.keys(errors).length === 0 &&
    error?.message
  ) {
    errors.body = String(error.message);
  }

  return {
    statusCode,
    body: {
      success: false,
      code: mapped.code,
      message: mapped.message,
      errorId: generateErrorId(),
      ...(error?.action ? { action: String(error.action) } : {}),
      ...(Object.keys(errors).length ? { errors } : {}),
    },
  };
}
