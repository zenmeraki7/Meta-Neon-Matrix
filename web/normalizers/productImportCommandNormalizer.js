const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_COLUMN_MAPPING_KEYS = 100;
const MAX_COLUMN_MAPPING_JSON_BYTES = 20_000;
const MAX_TEXT_LENGTH = 500;
const MAX_LIMIT = 250;
const MAX_UPLOAD_TOKEN_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_CONTEXT_JSON_LENGTH = 50_000;
const MAX_COLUMN_MAPPING_NODES = 500;
const MAX_COLUMN_MAPPING_DEPTH = 8;

const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/csv",
]);

const EMPTY_OBJECT = Object.freeze({});
const CREATE_IMPORT_BODY_KEYS = new Set(["columnMappings"]);
const PREVIEW_PAGE_QUERY_KEYS = new Set(["uploadToken", "cursor", "limit"]);
const CREATE_PREVIEW_QUERY_KEYS = new Set(["limit"]);

function buildRequestError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertPlainObject(value, fieldName) {
  if (!isPlainObject(value)) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }
  return value;
}

function assertNoPoisonKeys(value, fieldName) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw buildRequestError(`Invalid ${fieldName}: unsafe key`);
    }
  }
}

function assertNoUnknownKeys(value, allowedKeys, fieldName) {
  const safe = assertPlainObject(value, fieldName);
  const unknown = Object.keys(safe).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) {
    throw buildRequestError(`Invalid ${fieldName} keys: ${unknown.join(",")}`);
  }
  return safe;
}

function safeJsonClone(value, fieldName, maxLength) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw buildRequestError(`Invalid ${fieldName}`);
  }
  if (!json || json.length > maxLength) {
    throw buildRequestError(`Invalid ${fieldName}: too large`);
  }
  try {
    return JSON.parse(json);
  } catch {
    throw buildRequestError(`Invalid ${fieldName}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function countJsonNodes(
  value,
  { fieldName, maxDepth, maxNodes, depth = 0, state = { count: 0 } },
) {
  if (depth > maxDepth) {
    throw buildRequestError(`Invalid ${fieldName}: too deep`);
  }
  state.count += 1;
  if (state.count > maxNodes) {
    throw buildRequestError(`Invalid ${fieldName}: too many nodes`);
  }
  if (value === null || value === undefined) {
    return state.count;
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      countJsonNodes(child, {
        fieldName,
        maxDepth,
        maxNodes,
        depth: depth + 1,
        state,
      });
    }
    return state.count;
  }
  if (typeof value === "object") {
    assertPlainObject(value, fieldName);
    assertNoPoisonKeys(value, fieldName);
    for (const child of Object.values(value)) {
      countJsonNodes(child, {
        fieldName,
        maxDepth,
        maxNodes,
        depth: depth + 1,
        state,
      });
    }
  }
  return state.count;
}

function normalizeText(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw buildRequestError(`Invalid ${fieldName}: must be a string`);
  if (/[\u0000-\u001F\u007F]/.test(value)) throw buildRequestError(`Invalid ${fieldName}: control characters are not allowed`);
  const text = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > maxLength) throw buildRequestError(`Invalid ${fieldName}: too long`);
  return text;
}

function normalizeRequiredText(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  const text = normalizeText(value, fieldName, maxLength);
  if (!text) throw buildRequestError(`${fieldName} is required`);
  return text;
}

function normalizeIdempotencyKey(value) {
  const key = normalizeText(value, "Idempotency-Key", MAX_IDEMPOTENCY_KEY_LENGTH);
  if (!key) throw buildRequestError("Idempotency-Key header is required", "IDEMPOTENCY_KEY_REQUIRED");
  return key;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw buildRequestError(`Invalid limit: must be 1-${MAX_LIMIT}`);
  }
  return n;
}

function assertUploadFile(file) {
  if (!file?.path) {
    throw buildRequestError("CSV_FILE_REQUIRED", "CSV_FILE_REQUIRED");
  }
  if (Number(file.size || 0) > MAX_UPLOAD_SIZE_BYTES) {
    throw buildRequestError("CSV_FILE_TOO_LARGE", "CSV_FILE_TOO_LARGE");
  }
  const mimeType = String(file.mimetype || "").toLowerCase();
  if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
    throw buildRequestError("INVALID_CSV_MIME_TYPE", "INVALID_CSV_MIME_TYPE");
  }
  return file;
}

function parseColumnMappings(raw) {
  if (!raw) return {};
  const rawStr = String(raw);
  if (Buffer.byteLength(rawStr, "utf8") > MAX_COLUMN_MAPPING_JSON_BYTES) {
    throw buildRequestError("COLUMN_MAPPINGS_TOO_LARGE", "COLUMN_MAPPINGS_TOO_LARGE");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawStr);
  } catch {
    throw buildRequestError("INVALID_COLUMN_MAPPINGS", "INVALID_COLUMN_MAPPINGS");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw buildRequestError("INVALID_COLUMN_MAPPINGS", "INVALID_COLUMN_MAPPINGS");
  }
  if (Object.keys(parsed).length > MAX_COLUMN_MAPPING_KEYS) {
    throw buildRequestError("TOO_MANY_COLUMN_MAPPINGS", "TOO_MANY_COLUMN_MAPPINGS");
  }
  if (!Object.values(parsed).includes("id")) {
    throw buildRequestError("PRODUCT_ID_MAPPING_REQUIRED", "PRODUCT_ID_MAPPING_REQUIRED");
  }
  const cloned = safeJsonClone(
    parsed,
    "columnMappings",
    MAX_COLUMN_MAPPING_JSON_BYTES,
  );
  countJsonNodes(cloned, {
    fieldName: "columnMappings",
    maxDepth: MAX_COLUMN_MAPPING_DEPTH,
    maxNodes: MAX_COLUMN_MAPPING_NODES,
  });
  return deepFreeze(cloned);
}

function assertCommandContext({ shop, actor, subscription }) {
  const safe = { shop, actor, subscription };
  const safeShop = normalizeRequiredText(safe.shop, "shop", 255);
  return Object.freeze({
    shop: safeShop,
    actor: (() => {
      if (!safe.actor) return null;
      assertPlainObject(safe.actor, "actor");
      const clone = safeJsonClone(safe.actor, "actor", MAX_CONTEXT_JSON_LENGTH);
      assertNoPoisonKeys(clone, "actor");
      return deepFreeze(clone);
    })(),
    subscription: safe.subscription || null,
  });
}

export function buildCreateProductImportCommand({
  file,
  body = {},
  idempotencyKey,
  shop,
  actor = null,
  subscription = null,
}) {
  const safeContext = assertCommandContext({ shop, actor, subscription });
  const safeBody =
    body === undefined || body === null
      ? EMPTY_OBJECT
      : assertNoUnknownKeys(body, CREATE_IMPORT_BODY_KEYS, "body");
  return Object.freeze({
    ...safeContext,
    file: assertUploadFile(file),
    columnMappings: parseColumnMappings(safeBody.columnMappings),
    idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
  });
}

export function buildPreviewCsvPageCommand({
  query = {},
  shop,
  actor = null,
  subscription = null,
}) {
  const safeContext = assertCommandContext({ shop, actor, subscription });
  const safeQuery =
    query === undefined || query === null
      ? EMPTY_OBJECT
      : assertNoUnknownKeys(query, PREVIEW_PAGE_QUERY_KEYS, "query");
  const uploadToken = normalizeRequiredText(
    safeQuery.uploadToken,
    "uploadToken",
    MAX_UPLOAD_TOKEN_LENGTH,
  );
  return Object.freeze({
    ...safeContext,
    uploadToken,
    cursor: normalizeText(safeQuery.cursor, "cursor", 500),
    limit: normalizeLimit(safeQuery.limit),
  });
}

export function buildCreateCsvPreviewCommand({
  file,
  query = {},
  idempotencyKey,
  shop,
  actor = null,
  subscription = null,
}) {
  const safeContext = assertCommandContext({ shop, actor, subscription });
  const safeQuery =
    query === undefined || query === null
      ? EMPTY_OBJECT
      : assertNoUnknownKeys(query, CREATE_PREVIEW_QUERY_KEYS, "query");
  return Object.freeze({
    ...safeContext,
    file: assertUploadFile(file),
    limit: normalizeLimit(safeQuery.limit),
    idempotencyKey: normalizeIdempotencyKey(idempotencyKey),
  });
}
