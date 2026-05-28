export function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseAndValidateLimit(limitRaw, min = 1, max = 50, fallback = 20) {
  const limit =
    limitRaw === undefined || limitRaw === null || limitRaw === ""
      ? fallback
      : Number(limitRaw);

  if (!Number.isInteger(limit) || limit < min || limit > max) {
    const error = new Error(`Invalid query: limit must be an integer between ${min} and ${max}`);
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  return limit;
}

export function parseAndValidateCursor(cursorRaw, maxLen = 500) {
  const cursor =
    typeof cursorRaw === "string" && cursorRaw.trim()
      ? cursorRaw.trim()
      : undefined;

  if (cursor && cursor.length > maxLen) {
    const error = new Error(`Invalid query: cursor must be <= ${maxLen} chars`);
    error.code = "VALIDATION_ERROR";
    throw error;
  }

  return cursor;
}

export function validateAllowedQueryKeys(rawQuery = {}, allowedKeys = new Set()) {
  const unknownKeys = Object.keys(rawQuery || {}).filter(
    (key) => !allowedKeys.has(key),
  );

  if (unknownKeys.length > 0) {
    const error = new Error(`Invalid query keys: ${unknownKeys.join(",")}`);
    error.code = "VALIDATION_ERROR";
    throw error;
  }
}
