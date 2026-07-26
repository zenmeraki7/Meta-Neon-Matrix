// web/normalizers/bulkEditValidationLimits.js

export const BULK_EDIT_LIMITS = Object.freeze({
  MAX_FILTER_COUNT: 25,
  MAX_FILTER_DEPTH: 5,
  MAX_FILTER_AST_NODES: 100,

  MAX_PRODUCT_SELECTION_COUNT: 5_000,

  DEFAULT_VARIANT_DETAIL_PAGE_LIMIT: 25,
  MAX_VARIANT_DETAIL_PAGE_LIMIT: 100,

  MAX_SHORT_STRING_LENGTH: 255,
  MAX_FIELD_NAME_LENGTH: 100,
  MAX_OPERATION_NAME_LENGTH: 100,
  MAX_EDIT_VALUE_LENGTH: 60_000,

  MAX_SCHEDULE_EXPRESSION_LENGTH: 255,
  MAX_TIMEZONE_LENGTH: 100,

  MAX_OPERATION_ID_LENGTH: 128,
  MAX_PREVIEW_CONTRACT_ID_LENGTH: 128,
  MAX_IDEMPOTENCY_KEY_LENGTH: 255,
});

export function assertValidStringLength(value, fieldName, maxLength) {
  if (typeof value !== "string") return;
  if (value.length > maxLength) {
    const error = new Error(`Invalid ${fieldName}: length exceeds maximum allowed (${maxLength})`);
    error.code = "VALIDATION_FAILED";
    throw error;
  }
}

export function assertValidProductSelectionCount(count) {
  const num = Number(count || 0);
  if (num > BULK_EDIT_LIMITS.MAX_PRODUCT_SELECTION_COUNT) {
    const error = new Error(
      `Product selection count exceeds maximum limit (${BULK_EDIT_LIMITS.MAX_PRODUCT_SELECTION_COUNT})`,
    );
    error.code = "SELECTION_LIMIT_EXCEEDED";
    throw error;
  }
}

export function clampVariantDetailPageLimit(limit) {
  const parsed = Number.parseInt(String(limit || BULK_EDIT_LIMITS.DEFAULT_VARIANT_DETAIL_PAGE_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return BULK_EDIT_LIMITS.DEFAULT_VARIANT_DETAIL_PAGE_LIMIT;
  }
  return Math.min(parsed, BULK_EDIT_LIMITS.MAX_VARIANT_DETAIL_PAGE_LIMIT);
}
