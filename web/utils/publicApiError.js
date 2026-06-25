import { generateErrorId } from "./errorUtils.js";

const DEFAULT_MESSAGES = Object.freeze({
  UNAUTHENTICATED: "Authentication required.",
  UNAUTHORIZED: "Authentication required.",
  FORBIDDEN: "You are not allowed to perform this action",
  UPGRADE_REQUIRED: "This feature requires an active paid plan.",
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
  IDEMPOTENCY_KEY_REQUIRED: "Request idempotency key is required.",
  OPERATION_NOT_UNDOABLE: "This edit is not eligible for undo.",
  UNDO_ALREADY_QUEUED: "Undo is already queued for this edit.",
  UNDO_ELIGIBLE_TARGETS_NOT_FOUND: "No successfully edited targets are available to undo.",
  UNDO_HISTORY_NOT_FOUND: "The edit history record was not found.",
  UNDO_QUEUE_TRANSITION_REJECTED: "Undo could not be queued for this edit.",
  UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED: "Undo cannot run because before-values are missing.",
  UNDO_TARGET_IDENTITY_REQUIRED: "Undo cannot run because a target identity is missing.",
  UNDO_BEFORE_VALUES_REQUIRED: "Undo cannot run because before-values are missing.",
  UNDO_CONFLICT_REQUIRES_CONFIRMATION: "This undo has conflicts that require review.",
  SHOPIFY_UNDO_STAGED_UPLOAD_FAILED: "Shopify rejected the undo upload request.",
  SHOPIFY_UNDO_BULK_MUTATION_FAILED: "Shopify rejected the undo mutation.",
  SHOPIFY_UNDO_BULK_OPERATION_MISSING: "Shopify did not return an undo bulk operation id.",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again later.",
});

function statusFromCode(code = "INTERNAL_ERROR") {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "UNAUTHORIZED") return 403;
  if (code === "FORBIDDEN") return 403;
  if (code === "UPGRADE_REQUIRED") return 403;
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
  if (code === "IDEMPOTENCY_KEY_REQUIRED") return 400;
  if (code === "OPERATION_NOT_UNDOABLE") return 409;
  if (code === "UNDO_ALREADY_QUEUED") return 409;
  if (code === "UNDO_ELIGIBLE_TARGETS_NOT_FOUND") return 409;
  if (code === "UNDO_HISTORY_NOT_FOUND") return 404;
  if (code === "UNDO_QUEUE_TRANSITION_REJECTED") return 409;
  if (code === "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED") return 409;
  if (code === "UNDO_TARGET_IDENTITY_REQUIRED") return 409;
  if (code === "UNDO_BEFORE_VALUES_REQUIRED") return 409;
  if (code === "UNDO_CONFLICT_REQUIRES_CONFIRMATION") return 409;
  if (code === "SHOPIFY_UNDO_STAGED_UPLOAD_FAILED") return 502;
  if (code === "SHOPIFY_UNDO_BULK_MUTATION_FAILED") return 502;
  if (code === "SHOPIFY_UNDO_BULK_OPERATION_MISSING") return 502;
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
  if (raw === "IDEMPOTENCY_KEY_REQUIRED") {
    return { code: "IDEMPOTENCY_KEY_REQUIRED", message: DEFAULT_MESSAGES.IDEMPOTENCY_KEY_REQUIRED };
  }
  if (raw === "OPERATION_NOT_UNDOABLE") {
    return { code: "OPERATION_NOT_UNDOABLE", message: DEFAULT_MESSAGES.OPERATION_NOT_UNDOABLE };
  }
  if (raw === "UNDO_ALREADY_QUEUED") {
    return { code: "UNDO_ALREADY_QUEUED", message: DEFAULT_MESSAGES.UNDO_ALREADY_QUEUED };
  }
  if (raw === "UNDO_ELIGIBLE_TARGETS_NOT_FOUND") {
    return { code: "UNDO_ELIGIBLE_TARGETS_NOT_FOUND", message: DEFAULT_MESSAGES.UNDO_ELIGIBLE_TARGETS_NOT_FOUND };
  }
  if (raw === "UNDO_HISTORY_NOT_FOUND") {
    return { code: "UNDO_HISTORY_NOT_FOUND", message: DEFAULT_MESSAGES.UNDO_HISTORY_NOT_FOUND };
  }
  if (raw === "UNDO_QUEUE_TRANSITION_REJECTED") {
    return { code: "UNDO_QUEUE_TRANSITION_REJECTED", message: DEFAULT_MESSAGES.UNDO_QUEUE_TRANSITION_REJECTED };
  }
  if (raw === "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED") {
    return { code: "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED", message: DEFAULT_MESSAGES.UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED };
  }
  if (raw === "UNDO_TARGET_IDENTITY_REQUIRED") {
    return { code: "UNDO_TARGET_IDENTITY_REQUIRED", message: DEFAULT_MESSAGES.UNDO_TARGET_IDENTITY_REQUIRED };
  }
  if (raw === "UNDO_BEFORE_VALUES_REQUIRED") {
    return { code: "UNDO_BEFORE_VALUES_REQUIRED", message: DEFAULT_MESSAGES.UNDO_BEFORE_VALUES_REQUIRED };
  }
  if (raw === "UNDO_CONFLICT_REQUIRES_CONFIRMATION") {
    return { code: "UNDO_CONFLICT_REQUIRES_CONFIRMATION", message: DEFAULT_MESSAGES.UNDO_CONFLICT_REQUIRES_CONFIRMATION };
  }
  if (raw === "SHOPIFY_UNDO_STAGED_UPLOAD_FAILED") {
    return { code: "SHOPIFY_UNDO_STAGED_UPLOAD_FAILED", message: DEFAULT_MESSAGES.SHOPIFY_UNDO_STAGED_UPLOAD_FAILED };
  }
  if (raw === "SHOPIFY_UNDO_BULK_MUTATION_FAILED") {
    return { code: "SHOPIFY_UNDO_BULK_MUTATION_FAILED", message: DEFAULT_MESSAGES.SHOPIFY_UNDO_BULK_MUTATION_FAILED };
  }
  if (raw === "SHOPIFY_UNDO_BULK_OPERATION_MISSING") {
    return { code: "SHOPIFY_UNDO_BULK_OPERATION_MISSING", message: DEFAULT_MESSAGES.SHOPIFY_UNDO_BULK_OPERATION_MISSING };
  }
  if (raw.includes("PREMIUM_FEATURE_REQUIRED") || raw.includes("FORBIDDEN")) {
    return { code: "FORBIDDEN", message: DEFAULT_MESSAGES.FORBIDDEN };
  }
  if (raw.includes("UPGRADE_REQUIRED")) {
    return {
      code: "UPGRADE_REQUIRED",
      message: error?.message
        ? String(error.message)
        : DEFAULT_MESSAGES.UPGRADE_REQUIRED,
    };
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
  const details = error?.details && typeof error.details === "object"
    ? error.details
    : {};
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
      rootCause: error?.message ? String(error.message) : mapped.message,
      ...(mapped.code === "UPGRADE_REQUIRED"
        ? {
          feature: String(details.feature || "scheduled_edits"),
          upgradeRequired: true,
          billingUrl: String(details.billingUrl || "/pricing"),
        }
        : {}),
      ...(Object.keys(details).length ? { details } : {}),
      ...(process.env.NODE_ENV !== "production" && error?.stack ? { stack: String(error.stack) } : {}),
      ...(error?.action ? { action: String(error.action) } : {}),
      ...(Object.keys(errors).length ? { errors } : {}),
    },
  };
}
