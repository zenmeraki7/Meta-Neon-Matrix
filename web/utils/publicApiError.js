import { generateErrorId } from "./errorUtils.js";

const DEFAULT_MESSAGES = Object.freeze({
  UNAUTHENTICATED: "Authentication required.",
  AUTH_REQUIRED: "Authentication required.",
  UNAUTHORIZED: "Authentication required.",
  FORBIDDEN: "You are not allowed to perform this action",
  UPGRADE_REQUIRED: "This feature requires an active paid plan.",
  RECURRING_EDIT_PRO_PLAN_REQUIRED:
    "Recurring edits are available on paid plans. Please upgrade to continue.",
  CONFLICT: "Operation cannot be completed in the current state",
  VALIDATION_FAILED: "Request validation failed",
  NOT_FOUND: "Requested resource was not found",
  RATE_LIMITED: "Too many requests. Please retry shortly",
  TARGETING_REQUIRES_SYNC: "Refresh product data before previewing this edit.",
  TARGETING_FILTER_UNSUPPORTED:
    "This filter cannot be previewed safely. Refresh products or simplify the filter.",
  PREVIEW_NOT_FOUND: "Run preview again before applying this edit.",
  PREVIEW_FORBIDDEN: "This preview does not belong to the current shop.",
  PREVIEW_STALE:
    "Preview is stale. Run preview again before applying this edit.",
  FILTER_CONTRACT_REQUIRED:
    "Run preview again before saving this recurring edit.",
  PREVIEW_SNAPSHOT_INCOMPLETE:
    "Preview data is incomplete. Run preview again before applying this edit.",
  EDIT_EXECUTION_FAILED:
    "Unable to start this edit. Run preview again and retry.",
  EDIT_PREVIEW_FAILED: "Unable to generate edit preview.",
  IDEMPOTENCY_KEY_REQUIRED: "Request idempotency key is required.",
  INVALID_BILLING_PLAN: "Invalid billing plan.",
  UNKNOWN_BILLING_PLAN: "Unknown billing plan.",
  UNKNOWN_ACTIVE_SUBSCRIPTION: "Unknown active subscription.",
  MULTIPLE_ACTIVE_SUBSCRIPTIONS: "Multiple active subscriptions found.",
  BILLING_RESTRICTED: "Billing is restricted for this shop.",
  BILLING_STATE_UNAVAILABLE: "Billing state is unavailable.",
  BILLING_API_UNAVAILABLE:
    "Shopify billing is unavailable for this app configuration.",
  MOCK_BILLING_DISABLED: "Mock billing is disabled.",
  OPERATION_NOT_UNDOABLE: "This edit is not eligible for undo.",
  UNDO_ALREADY_QUEUED: "Undo is already queued for this edit.",
  UNDO_ELIGIBLE_TARGETS_NOT_FOUND:
    "No successfully edited targets are available to undo.",
  CSV_CREATE_UNDO_NOT_SUPPORTED:
    "This import created new products and cannot be safely undone.",
  UNDO_HISTORY_NOT_FOUND: "The edit history record was not found.",
  UNDO_QUEUE_TRANSITION_REJECTED: "Undo could not be queued for this edit.",
  UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED:
    "Undo cannot run because before-values are missing.",
  UNDO_TARGET_IDENTITY_REQUIRED:
    "Undo cannot run because a target identity is missing.",
  UNDO_BEFORE_VALUES_REQUIRED:
    "Undo cannot run because before-values are missing.",
  UNDO_CONFLICT_REQUIRES_CONFIRMATION:
    "This undo has conflicts that require review.",
  INVALID_HISTORY_ID: "A full immutable history identifier is required.",
  INVALID_OPERATION_ID: "A valid immutable operation identifier is required.",
  UNDO_NOT_ALLOWED: "This edit cannot be undone.",
  UNDO_SNAPSHOTS_INCOMPLETE:
    "The original before-state is incomplete, so this edit cannot be safely undone.",
  UNDO_EXECUTION_NOT_FOUND: "The undo execution was not found.",
  DATABASE_UNAVAILABLE: "Undo is temporarily unavailable. Please retry.",
  SHOPIFY_UNDO_STAGED_UPLOAD_FAILED:
    "Shopify rejected the undo upload request.",
  SHOPIFY_UNDO_BULK_MUTATION_FAILED: "Shopify rejected the undo mutation.",
  SHOPIFY_UNDO_BULK_OPERATION_MISSING:
    "Shopify did not return an undo bulk operation id.",
  INTERNAL_ERROR: "An unexpected error occurred. Please try again later.",
});

function statusFromCode(code = "INTERNAL_ERROR") {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "AUTH_REQUIRED") return 401;
  if (code === "UNAUTHORIZED") return 403;
  if (code === "FORBIDDEN") return 403;
  if (code === "UPGRADE_REQUIRED") return 403;
  if (code === "RECURRING_EDIT_PRO_PLAN_REQUIRED") return 403;
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT") return 409;
  if (code === "RATE_LIMITED") return 429;
  if (code === "VALIDATION_FAILED") return 400;
  if (code === "INVALID_HISTORY_ID") return 400;
  if (code === "INVALID_OPERATION_ID") return 400;
  if (code === "DATABASE_UNAVAILABLE") return 503;
  if (code === "UNDO_EXECUTION_NOT_FOUND") return 404;
  if (code === "UNDO_NOT_ALLOWED") return 409;
  if (code === "UNDO_SNAPSHOTS_INCOMPLETE") return 422;
  if (code === "TARGETING_REQUIRES_SYNC") return 409;
  if (code === "TARGETING_FILTER_UNSUPPORTED") return 422;
  if (code === "PREVIEW_NOT_FOUND") return 404;
  if (code === "PREVIEW_FORBIDDEN") return 403;
  if (code === "PREVIEW_STALE") return 409;
  if (code === "FILTER_CONTRACT_REQUIRED") return 400;
  if (code === "PREVIEW_SNAPSHOT_INCOMPLETE") return 409;
  if (code === "EDIT_EXECUTION_FAILED") return 500;
  if (code === "IDEMPOTENCY_KEY_REQUIRED") return 400;
  if (code === "INVALID_BILLING_PLAN") return 400;
  if (code === "UNKNOWN_BILLING_PLAN") return 409;
  if (code === "UNKNOWN_ACTIVE_SUBSCRIPTION") return 409;
  if (code === "MULTIPLE_ACTIVE_SUBSCRIPTIONS") return 409;
  if (code === "BILLING_RESTRICTED") return 403;
  if (code === "BILLING_STATE_UNAVAILABLE") return 403;
  if (code === "BILLING_API_UNAVAILABLE") return 403;
  if (code === "MOCK_BILLING_DISABLED") return 403;
  if (code === "OPERATION_NOT_UNDOABLE") return 409;
  if (code === "UNDO_ALREADY_QUEUED") return 409;
  if (code === "UNDO_ELIGIBLE_TARGETS_NOT_FOUND") return 409;
  if (code === "CSV_CREATE_UNDO_NOT_SUPPORTED") return 409;
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

export function mapErrorToPublicContract(
  error,
  fallbackCode = "INTERNAL_ERROR"
) {
  const raw = String(error?.code || error?.message || "").toUpperCase();

  if (
    raw.includes("SESSION") ||
    raw.includes("UNAUTHORIZED") ||
    raw.includes("UNAUTHENTICATED")
  ) {
    return {
      code: "UNAUTHENTICATED",
      message: DEFAULT_MESSAGES.UNAUTHENTICATED,
    };
  }
  if (raw === "AUTH_REQUIRED") {
    return { code: "AUTH_REQUIRED", message: DEFAULT_MESSAGES.AUTH_REQUIRED };
  }
  if (raw === "UNDO_HISTORY_NOT_FOUND") {
    return {
      code: "UNDO_HISTORY_NOT_FOUND",
      message: DEFAULT_MESSAGES.UNDO_HISTORY_NOT_FOUND,
    };
  }
  if (raw === "UNDO_EXECUTION_NOT_FOUND") {
    return {
      code: "UNDO_EXECUTION_NOT_FOUND",
      message: DEFAULT_MESSAGES.UNDO_EXECUTION_NOT_FOUND,
    };
  }
  if (raw === "UNDO_ELIGIBLE_TARGETS_NOT_FOUND") {
    return {
      code: "UNDO_ELIGIBLE_TARGETS_NOT_FOUND",
      message: DEFAULT_MESSAGES.UNDO_ELIGIBLE_TARGETS_NOT_FOUND,
    };
  }
  if (raw === "CSV_CREATE_UNDO_NOT_SUPPORTED") {
    return {
      code: "CSV_CREATE_UNDO_NOT_SUPPORTED",
      message: DEFAULT_MESSAGES.CSV_CREATE_UNDO_NOT_SUPPORTED,
    };
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
    raw === "PREVIEW_OWNERSHIP_UNBOUND" ||
    raw === "ACTOR_ID_REQUIRED_FOR_EXECUTE" ||
    raw === "PREVIEW_ACTOR_MISMATCH"
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
    return {
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: DEFAULT_MESSAGES.IDEMPOTENCY_KEY_REQUIRED,
    };
  }
  if (error?.code === "VALIDATION_FAILED" && error?.message) {
    return { code: "VALIDATION_FAILED", message: String(error.message) };
  }
  if (raw === "INVALID_BILLING_PLAN") {
    return {
      code: "INVALID_BILLING_PLAN",
      message: DEFAULT_MESSAGES.INVALID_BILLING_PLAN,
    };
  }
  if (raw === "UNKNOWN_BILLING_PLAN") {
    return {
      code: "UNKNOWN_BILLING_PLAN",
      message: error?.message
        ? String(error.message)
        : DEFAULT_MESSAGES.UNKNOWN_BILLING_PLAN,
    };
  }
  if (raw === "UNKNOWN_ACTIVE_SUBSCRIPTION") {
    return {
      code: "UNKNOWN_ACTIVE_SUBSCRIPTION",
      message: DEFAULT_MESSAGES.UNKNOWN_ACTIVE_SUBSCRIPTION,
    };
  }
  if (raw === "MULTIPLE_ACTIVE_SUBSCRIPTIONS") {
    return {
      code: "MULTIPLE_ACTIVE_SUBSCRIPTIONS",
      message: DEFAULT_MESSAGES.MULTIPLE_ACTIVE_SUBSCRIPTIONS,
    };
  }
  if (raw === "BILLING_RESTRICTED") {
    return {
      code: "BILLING_RESTRICTED",
      message: DEFAULT_MESSAGES.BILLING_RESTRICTED,
    };
  }
  if (raw === "BILLING_STATE_UNAVAILABLE") {
    return {
      code: "BILLING_STATE_UNAVAILABLE",
      message: DEFAULT_MESSAGES.BILLING_STATE_UNAVAILABLE,
    };
  }
  if (raw === "BILLING_API_UNAVAILABLE") {
    return {
      code: "BILLING_API_UNAVAILABLE",
      message: error?.message
        ? String(error.message)
        : DEFAULT_MESSAGES.BILLING_API_UNAVAILABLE,
    };
  }
  if (raw === "MOCK_BILLING_DISABLED") {
    return {
      code: "MOCK_BILLING_DISABLED",
      message: error?.message
        ? String(error.message)
        : DEFAULT_MESSAGES.MOCK_BILLING_DISABLED,
    };
  }
  if (raw === "OPERATION_NOT_UNDOABLE") {
    return {
      code: "OPERATION_NOT_UNDOABLE",
      message: DEFAULT_MESSAGES.OPERATION_NOT_UNDOABLE,
    };
  }
  if (raw === "UNDO_ALREADY_QUEUED") {
    return {
      code: "UNDO_ALREADY_QUEUED",
      message: DEFAULT_MESSAGES.UNDO_ALREADY_QUEUED,
    };
  }
  if (raw === "UNDO_HISTORY_NOT_FOUND") {
    return {
      code: "UNDO_HISTORY_NOT_FOUND",
      message: DEFAULT_MESSAGES.UNDO_HISTORY_NOT_FOUND,
    };
  }
  if (raw === "UNDO_QUEUE_TRANSITION_REJECTED") {
    return {
      code: "UNDO_QUEUE_TRANSITION_REJECTED",
      message: DEFAULT_MESSAGES.UNDO_QUEUE_TRANSITION_REJECTED,
    };
  }
  if (raw === "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED") {
    return {
      code: "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED",
      message: DEFAULT_MESSAGES.UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED,
    };
  }
  if (raw === "UNDO_TARGET_IDENTITY_REQUIRED") {
    return {
      code: "UNDO_TARGET_IDENTITY_REQUIRED",
      message: DEFAULT_MESSAGES.UNDO_TARGET_IDENTITY_REQUIRED,
    };
  }
  if (raw === "UNDO_BEFORE_VALUES_REQUIRED") {
    return {
      code: "UNDO_BEFORE_VALUES_REQUIRED",
      message: DEFAULT_MESSAGES.UNDO_BEFORE_VALUES_REQUIRED,
    };
  }
  if (raw === "UNDO_CONFLICT_REQUIRES_CONFIRMATION") {
    return {
      code: "UNDO_CONFLICT_REQUIRES_CONFIRMATION",
      message: DEFAULT_MESSAGES.UNDO_CONFLICT_REQUIRES_CONFIRMATION,
    };
  }
  if (raw === "INVALID_HISTORY_ID") {
    return {
      code: "INVALID_HISTORY_ID",
      message: DEFAULT_MESSAGES.INVALID_HISTORY_ID,
    };
  }
  if (raw === "INVALID_OPERATION_ID") {
    return {
      code: "INVALID_OPERATION_ID",
      message: DEFAULT_MESSAGES.INVALID_OPERATION_ID,
    };
  }
  if (raw === "UNDO_NOT_ALLOWED") {
    return {
      code: "UNDO_NOT_ALLOWED",
      message: DEFAULT_MESSAGES.UNDO_NOT_ALLOWED,
    };
  }
  if (raw === "UNDO_SNAPSHOTS_INCOMPLETE") {
    return {
      code: "UNDO_SNAPSHOTS_INCOMPLETE",
      message: DEFAULT_MESSAGES.UNDO_SNAPSHOTS_INCOMPLETE,
    };
  }
  if (raw === "UNDO_EXECUTION_NOT_FOUND") {
    return {
      code: "UNDO_EXECUTION_NOT_FOUND",
      message: DEFAULT_MESSAGES.UNDO_EXECUTION_NOT_FOUND,
    };
  }
  if (raw === "DATABASE_UNAVAILABLE") {
    return {
      code: "DATABASE_UNAVAILABLE",
      message: DEFAULT_MESSAGES.DATABASE_UNAVAILABLE,
    };
  }
  if (raw === "SHOPIFY_UNDO_STAGED_UPLOAD_FAILED") {
    return {
      code: "SHOPIFY_UNDO_STAGED_UPLOAD_FAILED",
      message: DEFAULT_MESSAGES.SHOPIFY_UNDO_STAGED_UPLOAD_FAILED,
    };
  }
  if (raw === "SHOPIFY_UNDO_BULK_MUTATION_FAILED") {
    return {
      code: "SHOPIFY_UNDO_BULK_MUTATION_FAILED",
      message: DEFAULT_MESSAGES.SHOPIFY_UNDO_BULK_MUTATION_FAILED,
    };
  }
  if (raw === "SHOPIFY_UNDO_BULK_OPERATION_MISSING") {
    return {
      code: "SHOPIFY_UNDO_BULK_OPERATION_MISSING",
      message: DEFAULT_MESSAGES.SHOPIFY_UNDO_BULK_OPERATION_MISSING,
    };
  }
  if (raw.includes("PREMIUM_FEATURE_REQUIRED") || raw.includes("FORBIDDEN")) {
    return { code: "FORBIDDEN", message: DEFAULT_MESSAGES.FORBIDDEN };
  }
  if (raw === "FILTER_CONTRACT_REQUIRED") {
    return {
      code: "FILTER_CONTRACT_REQUIRED",
      message: error?.message
        ? String(error.message)
        : DEFAULT_MESSAGES.FILTER_CONTRACT_REQUIRED,
    };
  }
  if (raw.includes("UPGRADE_REQUIRED")) {
    return {
      code: "UPGRADE_REQUIRED",
      message:
        error?.publicMessage || error?.message
          ? String(error.publicMessage || error.message)
          : DEFAULT_MESSAGES.UPGRADE_REQUIRED,
    };
  }
  if (raw === "RECURRING_EDIT_PRO_PLAN_REQUIRED") {
    return {
      code: "RECURRING_EDIT_PRO_PLAN_REQUIRED",
      message: error?.message
        ? String(error.message)
        : DEFAULT_MESSAGES.RECURRING_EDIT_PRO_PLAN_REQUIRED,
    };
  }
  if (
    raw.includes("STALE") ||
    raw.includes("MISMATCH") ||
    raw.includes("ALREADY") ||
    raw.includes("CANCEL_NOT_ALLOWED") ||
    raw.includes("CONFLICT")
  ) {
    return { code: "CONFLICT", message: DEFAULT_MESSAGES.CONFLICT };
  }
  if (
    raw.includes("INVALID") ||
    raw.includes("REQUIRED") ||
    raw.includes("FAILED") ||
    raw.includes("MISSING") ||
    raw.includes("LIMIT")
  ) {
    return {
      code: "VALIDATION_FAILED",
      message: DEFAULT_MESSAGES.VALIDATION_FAILED,
    };
  }

  const fallback = String(fallbackCode || "INTERNAL_ERROR").toUpperCase();
  return {
    code: fallback,
    message: DEFAULT_MESSAGES[fallback] || DEFAULT_MESSAGES.INTERNAL_ERROR,
  };
}

export function buildPublicApiErrorResponse(
  error,
  fallbackCode = "INTERNAL_ERROR"
) {
  const mapped = mapErrorToPublicContract(error, fallbackCode);
  const statusCode = statusFromCode(mapped.code);
  const details =
    error?.details && typeof error.details === "object" ? error.details : {};
  const fieldErrors = Array.isArray(error?.fields) ? error.fields : [];
  let errors = fieldErrors.reduce((acc, fieldError) => {
    const field = String(fieldError?.field || "body").trim() || "body";
    const message = String(
      fieldError?.error || fieldError?.message || mapped.message
    ).trim();
    acc[field] = message || mapped.message;
    return acc;
  }, {});
  if (
    error?.errors &&
    typeof error.errors === "object" &&
    !Array.isArray(error.errors)
  ) {
    errors = { ...errors, ...error.errors };
  }
  if (
    mapped.code === "VALIDATION_FAILED" &&
    Object.keys(errors).length === 0 &&
    error?.message
  ) {
    errors.body = String(error.message);
  }

  const exposeRootCause =
    process.env.NODE_ENV !== "production" && error?.expose !== true;

  return {
    statusCode,
    body: {
      ok: false,
      success: false,
      code: mapped.code,
      message: mapped.message,
      errorId: generateErrorId(),
      ...(exposeRootCause
        ? { rootCause: error?.message ? String(error.message) : mapped.message }
        : {}),
      ...(mapped.code === "UPGRADE_REQUIRED"
        ? {
            feature: String(details.feature || "unknown"),
            upgradeRequired: true,
            billingUrl: String(details.billingUrl || "/pricing"),
          }
        : {}),
      ...(mapped.code === "RECURRING_EDIT_PRO_PLAN_REQUIRED"
        ? {
            upgradeRequired: true,
            requiredPlan: String(details.requiredPlan || "paid"),
          }
        : {}),
      ...(Object.keys(details).length ? { details } : {}),
      ...(process.env.NODE_ENV !== "production" &&
      error?.expose !== true &&
      error?.stack
        ? { stack: String(error.stack) }
        : {}),
      ...(error?.action ? { action: String(error.action) } : {}),
      ...(Array.isArray(error?.allowedFields)
        ? { allowedFields: error.allowedFields.map(String) }
        : {}),
      ...(Object.keys(errors).length ? { errors } : {}),
    },
  };
}
