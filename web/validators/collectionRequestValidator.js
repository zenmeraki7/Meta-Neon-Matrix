import {
  normalizeSearch,
  parseAndValidateCursor,
  parseAndValidateLimit,
  validateAllowedQueryKeys,
} from "../http/queryNormalizers.js";

export const COLLECTION_LIST_KEYS = new Set(["search", "limit", "cursor"]);
export const COLLECTION_OPTIONS_KEYS = new Set(["search", "limit", "cursor"]);
export const LIVE_COLLECTION_KEYS = new Set(["search", "limit", "cursor"]);

export function validateCollectionQuery(rawQuery = {}, allowedKeys = COLLECTION_LIST_KEYS) {
  validateAllowedQueryKeys(rawQuery, allowedKeys);

  const search = normalizeSearch(rawQuery.search);
  if (search.length > 100) {
    const error = new Error("Invalid query: search must be <= 100 chars");
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  const limit = parseAndValidateLimit(rawQuery.limit, 1, 50, 20);
  const cursor = parseAndValidateCursor(rawQuery.cursor, 500);

  return Object.freeze({ search, limit, cursor });
}
