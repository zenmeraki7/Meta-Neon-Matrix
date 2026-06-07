function buildError(message, statusCode = 400, code = "VALIDATION_FAILED", fields = []) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (Array.isArray(fields) && fields.length) {
    error.fields = fields;
  }
  return error;
}

function isPlainObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
    return Object.freeze(value);
  }
  if (isPlainObject(value)) {
    Object.keys(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }
  return value;
}

function toTrimmedString(value, fallback = "") {
  if (value == null) return fallback;
  return String(value).trim();
}

function capLength(value, maxLength, fieldName) {
  // Missing or blank values normalize to ""; callers that need null should use
  // normalizeOptionalString, which converts this empty sentinel to null.
  const str = toTrimmedString(value);
  if (!str) return "";
  if (!Number.isInteger(maxLength) || maxLength <= 0) return str;
  if (str.length > maxLength) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: fieldName, error: `max length is ${maxLength}` },
    ]);
  }
  return str;
}

function normalizeOptionalString(value, maxLength, fieldName) {
  const str = capLength(value, maxLength, fieldName);
  return str || null;
}

function normalizeEnum(value, allowed, fieldName, { required = false, caseMode = "upper" } = {}) {
  const raw = toTrimmedString(value);
  if (!raw) {
    if (required) {
      throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
        { field: fieldName, error: "is required" },
      ]);
    }
    return null;
  }

  const normalized = caseMode === "lower" ? raw.toLowerCase() : raw.toUpperCase();
  if (!allowed.includes(normalized)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: fieldName, error: `must be one of ${allowed.join(",")}` },
    ]);
  }
  return normalized;
}

function normalizeIntInRange(value, { fallback, min, max, fieldName }) {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: fieldName, error: `must be between ${min} and ${max}` },
    ]);
  }

  return parsed;
}

function validateIdempotencyKey(value, fieldName = "idempotencyKey", { required = false } = {}) {
  const normalized = toTrimmedString(value);
  if (!normalized) {
    if (required) {
      throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
        { field: fieldName, error: "is required" },
      ]);
    }
    return null;
  }
  if (normalized.length < 16 || normalized.length > 128) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: fieldName, error: "must be 16-128 characters" },
    ]);
  }
  return normalized;
}

function validateNoUnsafeNestedObjects(value, fieldName, { allowedObjectPaths = new Set() } = {}) {
  const violations = [];

  const walk = (node, path) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${path}[${i}]`);
      }
      return;
    }

    if (!isPlainObject(node)) return;

    if (path && !allowedObjectPaths.has(path)) {
      violations.push({ field: fieldName, error: `unsafe nested object at ${path}` });
    }

    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      walk(child, childPath);
    }
  };

  walk(value, "");

  if (violations.length > 0) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", violations);
  }
}

function validateProductCursor(cursor) {
  if (!cursor) return null;
  const raw = toTrimmedString(cursor);
  if (!raw) return null;
  if (raw.length > 500) {
    throw buildError("Invalid cursor", 400, "INVALID_CURSOR");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw buildError("Invalid cursor", 400, "INVALID_CURSOR");
  }

  if (!isPlainObject(parsed)) {
    throw buildError("Invalid cursor", 400, "INVALID_CURSOR");
  }

  const updatedAt = toTrimmedString(parsed.updatedAt);
  const id = toTrimmedString(parsed.id);
  if (!updatedAt || !id || !/^\d+$/.test(id) || Number.isNaN(Date.parse(updatedAt))) {
    throw buildError("Invalid cursor", 400, "INVALID_CURSOR");
  }

  return raw;
}

function validateVariantCursor(cursor) {
  const raw = toTrimmedString(cursor);
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw buildError("Invalid cursor", 400, "INVALID_CURSOR");
  }
  return raw;
}

export {
  buildError,
  deepFreeze,
  isPlainObject,
  normalizeOptionalString,
  normalizeEnum,
  normalizeIntInRange,
  validateIdempotencyKey,
  validateNoUnsafeNestedObjects,
  validateProductCursor,
  validateVariantCursor,
  capLength,
  toTrimmedString,
};
