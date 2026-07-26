// web/normalizers/bulkEditValidationUtils.js

import { BULK_EDIT_LIMITS } from "./bulkEditValidationLimits.js";

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:/+-]+$/;

const FILTER_GROUP_KEYS = new Set([
  "type",
  "operator",
  "children",
]);

const FILTER_CONDITION_KEYS = new Set([
  "type",
  "field",
  "operator",
  "value",
]);

const ALLOWED_GROUP_OPERATORS = new Set(["AND", "OR"]);

const ALLOWED_CONDITION_OPERATORS = new Set([
  "EQUALS",
  "NOT_EQUALS",
  "CONTAINS",
  "NOT_CONTAINS",
  "STARTS_WITH",
  "ENDS_WITH",
  "GREATER_THAN",
  "GREATER_THAN_OR_EQUAL",
  "LESS_THAN",
  "LESS_THAN_OR_EQUAL",
  "IS_EMPTY",
  "IS_NOT_EMPTY",
  "IN",
  "NOT_IN",
]);

function buildValidationError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function requirePlainObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw buildValidationError(`${fieldName} must be an object`);
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    throw buildValidationError(`${fieldName} must be a plain object`);
  }

  return value;
}

export function rejectUnknownKeys(value, allowedKeys, fieldName = "request") {
  const object = requirePlainObject(value, fieldName);

  const unknownKeys = Object.keys(object).filter(
    (key) => !allowedKeys.has(key),
  );

  if (unknownKeys.length > 0) {
    throw buildValidationError(`${fieldName} contains unsupported fields`);
  }

  return object;
}

export function normalizeRequiredString(
  value,
  { fieldName, maxLength, pattern },
) {
  if (typeof value !== "string") {
    throw buildValidationError(`${fieldName} is required`);
  }

  const normalized = value.trim();

  if (!normalized) {
    throw buildValidationError(`${fieldName} is required`);
  }

  if (normalized.length > maxLength) {
    throw buildValidationError(`${fieldName} exceeds the maximum length`);
  }

  if (pattern && !pattern.test(normalized)) {
    throw buildValidationError(`${fieldName} is invalid`);
  }

  return normalized;
}

export function normalizeOptionalString(
  value,
  { fieldName, maxLength, pattern, fallback = null },
) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw buildValidationError(`${fieldName} must be a string`);
  }

  const normalized = value.trim();

  if (!normalized) {
    return fallback;
  }

  if (normalized.length > maxLength) {
    throw buildValidationError(`${fieldName} exceeds the maximum length`);
  }

  if (pattern && !pattern.test(normalized)) {
    throw buildValidationError(`${fieldName} is invalid`);
  }

  return normalized;
}

export function normalizeOperationId(value) {
  return normalizeRequiredString(value, {
    fieldName: "operationId",
    maxLength: BULK_EDIT_LIMITS.MAX_OPERATION_ID_LENGTH,
    pattern: ID_PATTERN,
  });
}

export function normalizePreviewContractId(value) {
  return normalizeRequiredString(value, {
    fieldName: "previewContractId",
    maxLength: BULK_EDIT_LIMITS.MAX_PREVIEW_CONTRACT_ID_LENGTH,
    pattern: ID_PATTERN,
  });
}

export function normalizeIdempotencyKey(value) {
  return normalizeRequiredString(value, {
    fieldName: "Idempotency-Key",
    maxLength: BULK_EDIT_LIMITS.MAX_IDEMPOTENCY_KEY_LENGTH,
    pattern: IDEMPOTENCY_KEY_PATTERN,
  });
}

export function normalizeTimezone(value) {
  const timezone = normalizeRequiredString(value, {
    fieldName: "timezone",
    maxLength: BULK_EDIT_LIMITS.MAX_TIMEZONE_LENGTH,
  });

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).format();
  } catch {
    throw buildValidationError("timezone is invalid");
  }

  return timezone;
}

export function normalizeScheduleExpression(value) {
  const expression = normalizeRequiredString(value, {
    fieldName: "scheduleExpression",
    maxLength: BULK_EDIT_LIMITS.MAX_SCHEDULE_EXPRESSION_LENGTH,
  });

  if (expression.includes("\n") || expression.includes("\r")) {
    throw buildValidationError("scheduleExpression is invalid");
  }

  return expression;
}

export function normalizeVariantDetailLimit(value) {
  if (value === undefined || value === null || value === "") {
    return BULK_EDIT_LIMITS.DEFAULT_VARIANT_DETAIL_PAGE_LIMIT;
  }

  const limit = Number(value);

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > BULK_EDIT_LIMITS.MAX_VARIANT_DETAIL_PAGE_LIMIT
  ) {
    throw buildValidationError(
      `limit must be an integer between 1 and ${BULK_EDIT_LIMITS.MAX_VARIANT_DETAIL_PAGE_LIMIT}`,
    );
  }

  return limit;
}

export function normalizeProductSelection(value) {
  if (!Array.isArray(value)) {
    throw buildValidationError("productIds must be an array");
  }

  if (value.length > BULK_EDIT_LIMITS.MAX_PRODUCT_SELECTION_COUNT) {
    throw buildValidationError(
      `productIds cannot contain more than ${BULK_EDIT_LIMITS.MAX_PRODUCT_SELECTION_COUNT} items`,
    );
  }

  const normalized = [];
  const seen = new Set();

  for (const rawId of value) {
    const id = normalizeRequiredString(rawId, {
      fieldName: "productId",
      maxLength: 128,
      pattern: /^gid:\/\/shopify\/Product\/\d+$/,
    });

    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }

  return Object.freeze(normalized);
}

export function normalizeFilterAst(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const state = {
    nodeCount: 0,
    conditionCount: 0,
  };

  const normalized = normalizeFilterNode({
    node: value,
    depth: 1,
    state,
  });

  if (state.conditionCount > BULK_EDIT_LIMITS.MAX_FILTER_COUNT) {
    throw buildValidationError(
      `filter count cannot exceed ${BULK_EDIT_LIMITS.MAX_FILTER_COUNT}`,
    );
  }

  if (state.nodeCount > BULK_EDIT_LIMITS.MAX_FILTER_AST_NODES) {
    throw buildValidationError(
      `filter AST cannot exceed ${BULK_EDIT_LIMITS.MAX_FILTER_AST_NODES} nodes`,
    );
  }

  return deepFreeze(normalized);
}

function normalizeFilterNode({ node, depth, state }) {
  if (depth > BULK_EDIT_LIMITS.MAX_FILTER_DEPTH) {
    throw buildValidationError(
      `filter depth cannot exceed ${BULK_EDIT_LIMITS.MAX_FILTER_DEPTH}`,
    );
  }

  state.nodeCount += 1;

  if (state.nodeCount > BULK_EDIT_LIMITS.MAX_FILTER_AST_NODES) {
    throw buildValidationError(
      `filter AST cannot exceed ${BULK_EDIT_LIMITS.MAX_FILTER_AST_NODES} nodes`,
    );
  }

  const object = requirePlainObject(node, "filter node");

  if (object.type === "GROUP") {
    rejectUnknownKeys(object, FILTER_GROUP_KEYS, "filter group");

    const operator = String(object.operator ?? "")
      .trim()
      .toUpperCase();

    if (!ALLOWED_GROUP_OPERATORS.has(operator)) {
      throw buildValidationError("filter group operator is invalid");
    }

    if (!Array.isArray(object.children) || object.children.length === 0) {
      throw buildValidationError("filter group must contain children");
    }

    if (object.children.length > BULK_EDIT_LIMITS.MAX_FILTER_COUNT) {
      throw buildValidationError("filter group contains too many children");
    }

    return {
      type: "GROUP",
      operator,
      children: object.children.map((child) =>
        normalizeFilterNode({
          node: child,
          depth: depth + 1,
          state,
        }),
      ),
    };
  }

  if (object.type === "CONDITION") {
    rejectUnknownKeys(object, FILTER_CONDITION_KEYS, "filter condition");

    state.conditionCount += 1;

    if (state.conditionCount > BULK_EDIT_LIMITS.MAX_FILTER_COUNT) {
      throw buildValidationError(
        `filter count cannot exceed ${BULK_EDIT_LIMITS.MAX_FILTER_COUNT}`,
      );
    }

    const field = normalizeRequiredString(object.field, {
      fieldName: "filter field",
      maxLength: BULK_EDIT_LIMITS.MAX_FIELD_NAME_LENGTH,
    });

    const operator = String(object.operator ?? "")
      .trim()
      .toUpperCase();

    if (!ALLOWED_CONDITION_OPERATORS.has(operator)) {
      throw buildValidationError("filter condition operator is invalid");
    }

    return {
      type: "CONDITION",
      field,
      operator,
      value: normalizeFilterValue(object.value),
    };
  }

  throw buildValidationError("filter node type is invalid");
}

function normalizeFilterValue(value) {
  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    if (value.length > BULK_EDIT_LIMITS.MAX_SHORT_STRING_LENGTH) {
      throw buildValidationError("filter value exceeds the maximum length");
    }

    return value.trim();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw buildValidationError("filter value must be finite");
    }

    return value;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > BULK_EDIT_LIMITS.MAX_FILTER_COUNT) {
      throw buildValidationError("filter value array is too large");
    }

    return Object.freeze(value.map(normalizeFilterValue));
  }

  throw buildValidationError("filter value type is invalid");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return value;
}
