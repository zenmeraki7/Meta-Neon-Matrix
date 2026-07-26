// web/validators/collectionRequestValidator.js

import { validateAllowedQueryKeys } from "../http/queryNormalizers.js";

export const COLLECTION_LIST_KEYS = new Set(["search", "limit", "cursor"]);
export const COLLECTION_OPTIONS_KEYS = new Set(["search", "limit", "cursor"]);
export const LIVE_COLLECTION_KEYS = new Set(["search", "limit", "cursor"]);

export const COLLECTION_LIST_LIMITS = Object.freeze({
  min: 1,
  max: 100,
  default: 20,
});

export const COLLECTION_OPTIONS_LIMITS = Object.freeze({
  min: 1,
  max: 50,
  default: 50,
});

export const LIVE_COLLECTION_LIMITS = Object.freeze({
  min: 1,
  max: 50,
  default: 20,
});

const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

function buildValidationError(message, code = "VALIDATION_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertNoControlChars(value, fieldName) {
  if (typeof value === "string" && CONTROL_CHAR_PATTERN.test(value)) {
    throw buildValidationError(
      `Invalid query: ${fieldName} must not contain control characters`,
    );
  }
}

export function validateSearch(searchRaw, maxLength = 100) {
  if (searchRaw === undefined || searchRaw === null || searchRaw === "") {
    return "";
  }

  if (typeof searchRaw !== "string") {
    throw buildValidationError("Invalid query: search must be a string");
  }

  assertNoControlChars(searchRaw, "search");

  const normalized = searchRaw
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length > maxLength) {
    throw buildValidationError(
      `Invalid query: search must be <= ${maxLength} characters`,
    );
  }

  return normalized;
}

export function validateCursor(cursorRaw, maxLength = 512) {
  if (cursorRaw === undefined || cursorRaw === null || cursorRaw === "") {
    return undefined;
  }

  if (typeof cursorRaw !== "string") {
    throw buildValidationError("Invalid query: cursor must be a string");
  }

  assertNoControlChars(cursorRaw, "cursor");

  const trimmed = cursorRaw.trim();

  if (!trimmed) {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    throw buildValidationError(
      `Invalid query: cursor must be <= ${maxLength} characters`,
    );
  }

  return trimmed;
}

export function validateIntegerLimit(limitRaw, { min, max, default: fallback }) {
  if (limitRaw === undefined || limitRaw === null || limitRaw === "") {
    return fallback;
  }

  const str = String(limitRaw).trim();

  if (!/^-?\d+$/.test(str)) {
    throw buildValidationError(
      `Invalid query: limit must be an integer between ${min} and ${max}`,
    );
  }

  const limit = Number.parseInt(str, 10);

  if (!Number.isInteger(limit) || limit < min || limit > max) {
    throw buildValidationError(
      `Invalid query: limit must be an integer between ${min} and ${max}`,
    );
  }

  return limit;
}

export function validateCollectionQuery(
  rawQuery = {},
  allowedKeys = COLLECTION_LIST_KEYS,
  limits = COLLECTION_LIST_LIMITS,
) {
  validateAllowedQueryKeys(rawQuery, allowedKeys);

  const search = validateSearch(rawQuery.search, 100);
  const limit = validateIntegerLimit(rawQuery.limit, limits);
  const cursor = validateCursor(rawQuery.cursor, 512);

  return Object.freeze({ search, limit, cursor });
}
