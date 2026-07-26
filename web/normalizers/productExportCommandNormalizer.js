// web/normalizers/productExportCommandNormalizer.js

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_FILE_NAME_LENGTH = 255;
const MAX_FIELD_NAME_LENGTH = 160;
const MAX_FIELDS = 300;

const MAX_FILTER_PARAMS = 500;
const MAX_FILTER_PARAM_ARRAY_VALUES = 250;
const MAX_FILTER_PARAM_VALUE_LENGTH = 5_000;

const MAX_FILTER_AST_DEPTH = 12;
const MAX_FILTER_AST_NODES = 1_000;
const MAX_FILTER_AST_JSON_LENGTH = 200_000;

const MAX_CONTEXT_JSON_LENGTH = 50_000;

const EMPTY_OBJECT = Object.freeze({});
const EMPTY_ARRAY = Object.freeze([]);

const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\- ()]*$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;

const CREATE_EXPORT_BODY_KEYS = new Set([
  "fields",
  "fileName",
  "rawFilterInput",
  "filterAst",
  "context",
  "options",
]);

const CANCEL_EXPORT_BODY_KEYS = new Set([
  "cancelReason",
]);

function buildRequestError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
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

function assertPlainObject(value, fieldName) {
  if (!isPlainObject(value)) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return value;
}

function assertNoUnknownKeys(value, allowedKeys, fieldName) {
  const safe = assertPlainObject(value, fieldName);

  const unknownKeys = Object.keys(safe).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw buildRequestError(
      `Invalid ${fieldName} keys: ${unknownKeys.join(",")}`,
    );
  }

  return safe;
}

function assertNoPoisonKeys(value, fieldName) {
  if (!isPlainObject(value)) {
    return;
  }

  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw buildRequestError(`Invalid ${fieldName}: unsafe key`);
    }
  }
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
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}

function countJsonNodes(
  value,
  {
    fieldName,
    maxDepth,
    maxNodes,
    depth = 0,
    state = { count: 0 },
  },
) {
  if (depth > maxDepth) {
    throw buildRequestError(`Invalid ${fieldName}: too deep`);
  }

  state.count += 1;

  if (state.count > maxNodes) {
    throw buildRequestError(`Invalid ${fieldName}: too many nodes`);
  }

  if (value === null) {
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
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw buildRequestError(`Invalid ${fieldName}: must be a string`);
  }

  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw buildRequestError(
      `Invalid ${fieldName}: control characters are not allowed`,
    );
  }

  const trimmed = value.normalize("NFKC").replace(/\s+/g, " ").trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length > maxLength) {
    throw buildRequestError(`Invalid ${fieldName}: too long`);
  }

  return trimmed;
}

function normalizeRequiredText(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  const normalized = normalizeText(value, fieldName, maxLength);

  if (!normalized) {
    throw buildRequestError(`${fieldName} is required`);
  }

  return normalized;
}

function normalizeSafeToken(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  const token = normalizeRequiredText(value, fieldName, maxLength);

  if (!SAFE_TOKEN_PATTERN.test(token)) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return token;
}

function normalizeId(value, fieldName = "id") {
  return normalizeSafeToken(value, fieldName, MAX_ID_LENGTH);
}

function normalizeIdempotencyKey(headers = {}) {
  const safeHeaders = headers && typeof headers === "object" ? headers : {};
  const key = normalizeText(safeHeaders.idempotencyKey, "Idempotency-Key", 200);

  if (!key) {
    throw buildRequestError(
      "Idempotency-Key header is required",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }

  return key;
}

function normalizeFileName(value) {
  const fileName = normalizeRequiredText(
    value,
    "fileName",
    MAX_FILE_NAME_LENGTH,
  );

  if (!SAFE_FILE_NAME_PATTERN.test(fileName)) {
    throw buildRequestError("Invalid fileName");
  }

  if (
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw buildRequestError("Invalid fileName");
  }

  return fileName;
}

function normalizeExportField(value, index) {
  return normalizeSafeToken(
    value,
    `fields[${index}]`,
    MAX_FIELD_NAME_LENGTH,
  );
}

function normalizeExportFields(value) {
  if (!Array.isArray(value)) {
    throw buildRequestError("Invalid fields: must be an array");
  }

  if (value.length < 1) {
    throw buildRequestError("FIELDS_REQUIRED", "VALIDATION_FAILED");
  }

  if (value.length > MAX_FIELDS) {
    throw buildRequestError("Invalid fields: too many fields");
  }

  const fields = value.map(normalizeExportField);
  const unique = [...new Set(fields)];

  if (unique.length !== fields.length) {
    throw buildRequestError("Invalid fields: duplicate fields are not allowed");
  }

  return Object.freeze(unique);
}

function normalizeFilterAst(value) {
  if (value === undefined || value === null) {
    return null;
  }

  assertPlainObject(value, "filterAst");
  assertNoPoisonKeys(value, "filterAst");

  const cloned = safeJsonClone(
    value,
    "filterAst",
    MAX_FILTER_AST_JSON_LENGTH,
  );

  countJsonNodes(cloned, {
    fieldName: "filterAst",
    maxDepth: MAX_FILTER_AST_DEPTH,
    maxNodes: MAX_FILTER_AST_NODES,
  });

  return deepFreeze(cloned);
}

function normalizeFilterParamValue(value, fieldName = "filter value") {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return normalizeText(value, fieldName, MAX_FILTER_PARAM_VALUE_LENGTH);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw buildRequestError(`Invalid ${fieldName}`);
    }

    return value;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_FILTER_PARAM_ARRAY_VALUES) {
      throw buildRequestError(`Invalid ${fieldName}: too many values`);
    }

    return Object.freeze(
      value.map((item, index) =>
        normalizeFilterParamValue(item, `${fieldName}[${index}]`),
      ),
    );
  }

  throw buildRequestError(`Invalid ${fieldName}`);
}

function normalizeFilterParam(item, index) {
  const safe = assertPlainObject(item, `rawFilterInput[${index}]`);
  assertNoPoisonKeys(safe, `rawFilterInput[${index}]`);

  return Object.freeze({
    field: normalizeSafeToken(
      safe.field,
      `rawFilterInput[${index}].field`,
      160,
    ),
    operator: normalizeSafeToken(
      safe.operator,
      `rawFilterInput[${index}].operator`,
      160,
    ),
    value: normalizeFilterParamValue(
      safe.value,
      `rawFilterInput[${index}].value`,
    ),
  });
}

function normalizeFilterParams(value) {
  if (value === undefined || value === null) {
    return EMPTY_ARRAY;
  }

  if (!Array.isArray(value)) {
    throw buildRequestError("Invalid rawFilterInput: must be an array");
  }

  if (value.length > MAX_FILTER_PARAMS) {
    throw buildRequestError("Invalid rawFilterInput: too many filters");
  }

  return Object.freeze(value.map(normalizeFilterParam));
}

function normalizeOptionalPlainObject(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  assertPlainObject(value, fieldName);
  assertNoPoisonKeys(value, fieldName);

  const cloned = safeJsonClone(value, fieldName, MAX_CONTEXT_JSON_LENGTH);

  countJsonNodes(cloned, {
    fieldName,
    maxDepth: 4,
    maxNodes: 100,
  });

  return deepFreeze(cloned);
}

function normalizeOptionalPlainObjectFallback(value, fieldName) {
  return normalizeOptionalPlainObject(value, fieldName) || EMPTY_OBJECT;
}

function normalizeExportOptions(value) {
  const safe = normalizeOptionalPlainObjectFallback(value, "options");
  const targetGranularity = String(safe.targetGranularity || "PRODUCT")
    .trim()
    .toUpperCase();

  if (!["PRODUCT", "VARIANT"].includes(targetGranularity)) {
    throw buildRequestError("Invalid options.targetGranularity");
  }

  return Object.freeze({
    targetGranularity,
  });
}

function assertCommandContext(context) {
  const safe = assertPlainObject(context, "command context");

  if (!safe.shop || typeof safe.shop !== "string") {
    throw buildRequestError("Authentication required", "UNAUTHENTICATED");
  }

  return Object.freeze({
    shop: normalizeRequiredText(safe.shop, "shop", 255),
    actor: normalizeOptionalPlainObject(safe.actor, "actor"),
    subscription: normalizeOptionalPlainObject(safe.subscription, "subscription"),
    entitlement: normalizeOptionalPlainObject(safe.entitlement, "entitlement"),
    activePlan: normalizeOptionalPlainObjectFallback(
      safe.activePlan,
      "activePlan",
    ),
  });
}

export function buildCreateProductExportCommand({
  body = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  const safeBody = assertNoUnknownKeys(
    body,
    CREATE_EXPORT_BODY_KEYS,
    "body",
  );

  return Object.freeze({
    ...safeContext,
    fields: normalizeExportFields(safeBody.fields),
    fileName: normalizeFileName(safeBody.fileName),
    rawFilterInput: normalizeFilterParams(safeBody.rawFilterInput),
    filterAst: normalizeFilterAst(safeBody.filterAst),
    clientContext: normalizeOptionalPlainObject(safeBody.context, "context"),
    options: normalizeExportOptions(safeBody.options),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildDownloadProductExportCommand({
  params = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  return Object.freeze({
    ...safeContext,
    exportJobId: normalizeId(params.id, "exportJobId"),
  });
}

export function buildCancelExportCommand({
  params = {},
  body = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  const safeBody =
    body === undefined || body === null
      ? EMPTY_OBJECT
      : assertNoUnknownKeys(body, CANCEL_EXPORT_BODY_KEYS, "body");

  return Object.freeze({
    ...safeContext,
    exportJobId: normalizeId(params.id, "exportJobId"),
    reason: normalizeText(safeBody.cancelReason, "cancelReason", 300),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildPauseExportCommand({
  params = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  return Object.freeze({
    ...safeContext,
    exportJobId: normalizeId(params.id, "exportJobId"),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildResumeExportCommand({
  params = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  return Object.freeze({
    ...safeContext,
    exportJobId: normalizeId(params.id, "exportJobId"),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

const ALLOWED_TARGET_GRANULARITIES = new Set(["PRODUCT", "VARIANT"]);

export function buildListProductExportFieldsCommand({ query, context }) {
  const targetGranularity = String(query?.targetGranularity ?? "PRODUCT")
    .trim()
    .toUpperCase();

  if (!ALLOWED_TARGET_GRANULARITIES.has(targetGranularity)) {
    const error = new Error("Invalid target granularity");
    error.code = "VALIDATION_FAILED";
    throw error;
  }

  return Object.freeze({
    type: "LIST_PRODUCT_EXPORT_FIELDS",
    shop: context.shop,
    actor: context.actor,
    targetGranularity,
  });
}
