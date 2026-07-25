const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_LONG_TEXT_LENGTH = 5_000;
const MAX_CURSOR_LENGTH = 500;
const MAX_LIMIT = 250;

const MAX_FILTER_PARAMS = 500;
const MAX_FILTER_PARAM_ARRAY_VALUES = 250;
const MAX_FILTER_PARAM_VALUE_LENGTH = 5_000;

const MAX_PRODUCT_IDS = 5_000;

const MAX_FILTER_AST_DEPTH = 12;
const MAX_FILTER_AST_NODES = 1_000;
const MAX_FILTER_AST_JSON_LENGTH = 200_000;

const MAX_EDIT_VALUE_JSON_LENGTH = 50_000;
const MAX_EDIT_VALUE_DEPTH = 8;
const MAX_EDIT_VALUE_NODES = 500;

const MAX_CONTEXT_JSON_LENGTH = 50_000;

const EMPTY_OBJECT = Object.freeze({});
const EMPTY_ARRAY = Object.freeze([]);

const FREEZE_MODES = new Set([
  "STATIC_AT_SCHEDULE_CREATE",
  "DYNAMIC_AT_RUN",
]);

const SEARCH_REPLACE_EDIT_TYPES = new Set([
  "Search/Replace",
  "Rename tag",
  "Search/replace within tag name",
]);

const CANONICAL_OPERATION_TO_LEGACY_EDIT_TYPE = Object.freeze({
  SET_FIXED: "Set to fixed value",
  INCREASE_FIXED: "Changed by fixed amount",
  DECREASE_FIXED: "Changed by fixed amount",
  INCREASE_PERCENT: "Increase by percent",
  DECREASE_PERCENT: "Decrease by percent",
  PERCENT_OF_COMPARE_AT_PRICE: "Set to percentage of compare-at-price",
});

function buildRequestError(message, code = "VALIDATION_FAILED", fields = []) {
  const error = new Error(message);
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

function assertPlainObject(value, fieldName) {
  if (!isPlainObject(value)) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return value;
}

function optionalPlainObject(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }

  return assertPlainObject(value, fieldName);
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

function countJsonNodes(value, {
  fieldName,
  maxDepth,
  maxNodes,
  depth = 0,
  state = { count: 0 },
}) {
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

function normalizeId(value, fieldName = "id") {
  const normalized = normalizeRequiredText(value, fieldName, MAX_ID_LENGTH);

  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizeOptionalId(value, fieldName = "id") {
  const normalized = normalizeText(value, fieldName, MAX_ID_LENGTH);

  if (!normalized) {
    return null;
  }

  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw buildRequestError(`Invalid limit: must be 1-${MAX_LIMIT}`);
  }

  return limit;
}

function normalizePreviewLimit(value) {
  if (value === undefined || value === null || value === "") {
    return 10;
  }

  const limit = Number(value);

  if (!Number.isFinite(limit)) {
    throw buildRequestError("Limit must be a valid number.", "VALIDATION_FAILED", [
      { field: "limit", error: "Limit must be a valid number." },
    ]);
  }

  return Math.max(1, Math.min(50, Math.floor(limit)));
}

function normalizePage(value) {
  if (value === undefined || value === null || value === "") {
    return 1;
  }

  const page = Number(value);

  if (!Number.isInteger(page) || page < 1) {
    throw buildRequestError("Page must be a positive integer.", "VALIDATION_FAILED", [
      { field: "page", error: "Page must be a positive integer." },
    ]);
  }

  return page;
}

function normalizeCount(value, fieldName = "count") {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const count = Number(value);

  if (!Number.isInteger(count) || count < 0 || count > MAX_PRODUCT_IDS) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return count;
}

function normalizeCursor(value) {
  return normalizeText(value, "cursor", MAX_CURSOR_LENGTH);
}

function normalizeLang(value) {
  const lang = normalizeText(value, "lang", 20) || "en";

  if (!/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})?$/.test(lang)) {
    throw buildRequestError("Invalid lang");
  }

  return lang;
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
    field: normalizeRequiredText(
      safe.field,
      `rawFilterInput[${index}].field`,
      160,
    ),
    operator: normalizeRequiredText(
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

function normalizeProductIds(value) {
  if (value === undefined || value === null) {
    return EMPTY_ARRAY;
  }

  if (!Array.isArray(value)) {
    throw buildRequestError("Invalid productIds: must be an array");
  }

  if (value.length > MAX_PRODUCT_IDS) {
    throw buildRequestError("Invalid productIds: too many ids");
  }

  return Object.freeze(value.map((id) => normalizeId(id, "productId")));
}

function normalizeEditValue(value, fieldName = "editValue") {
  if (value === undefined) {
    return null;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return normalizeText(value, fieldName, MAX_LONG_TEXT_LENGTH);
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

  if (isPlainObject(value)) {
    assertNoPoisonKeys(value, fieldName);

    const cloned = safeJsonClone(
      value,
      fieldName,
      MAX_EDIT_VALUE_JSON_LENGTH,
    );

    countJsonNodes(cloned, {
      fieldName,
      maxDepth: MAX_EDIT_VALUE_DEPTH,
      maxNodes: MAX_EDIT_VALUE_NODES,
    });

    return deepFreeze(cloned);
  }

  throw buildRequestError(`Invalid ${fieldName}`);
}

function normalizeDateString(value, fieldName, required = false) {
  const text = normalizeText(value, fieldName, 80);

  if (!text) {
    if (required) {
      throw buildRequestError(`${fieldName} is required`);
    }

    return null;
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return date.toISOString();
}

function normalizeUtcIsoDateString(value, fieldName, required = false) {
  const text = normalizeText(value, fieldName, 80);

  if (!text) {
    if (required) {
      throw buildRequestError(`${fieldName} is required`);
    }

    return null;
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw buildRequestError(`Invalid ${fieldName}: must be a UTC ISO string`);
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }

  return date.toISOString();
}

function normalizeFutureUtcIsoDateString(value, fieldName, required = false) {
  const iso = normalizeUtcIsoDateString(value, fieldName, required);

  if (!iso) {
    return null;
  }

  if (new Date(iso).getTime() <= Date.now()) {
    throw buildRequestError(`Invalid ${fieldName}: must be in the future`);
  }

  return iso;
}

function normalizeScheduleTimezone(value) {
  const timezone = normalizeRequiredText(value, "timezone", 120);

  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw buildRequestError("Invalid timezone");
  }

  return timezone;
}

function normalizeFreezeMode(value) {
  const mode = normalizeRequiredText(value, "freezeMode", 80);

  if (!FREEZE_MODES.has(mode)) {
    throw buildRequestError("INVALID_FREEZE_MODE", "VALIDATION_FAILED");
  }

  return mode;
}

function normalizeCancelReason(value) {
  return normalizeText(value, "cancelReason", 300);
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

function assertCommandContext(context) {
  const safe = assertPlainObject(context, "command context");

  if (!safe.shop || typeof safe.shop !== "string") {
    throw buildRequestError("Authentication required", "UNAUTHENTICATED");
  }

  return Object.freeze({
    shop: normalizeRequiredText(safe.shop, "shop", 255),
    accessToken: normalizeText(safe.accessToken, "accessToken", MAX_LONG_TEXT_LENGTH),
    oauthScopes: normalizeText(safe.oauthScopes, "oauthScopes", MAX_LONG_TEXT_LENGTH),
    actor: normalizeOptionalPlainObject(safe.actor, "actor"),
    subscription: normalizeOptionalPlainObject(safe.subscription, "subscription"),
    entitlement: normalizeOptionalPlainObject(safe.entitlement, "entitlement"),
    activePlan: normalizeOptionalPlainObjectFallback(
      safe.activePlan,
      "activePlan",
    ),
  });
}

function normalizeEditPayload({ body = {}, query = {} }) {
  const safeBody = assertPlainObject(body, "body");
  const safeQuery =
    query && typeof query === "object" && !Array.isArray(query) ? query : {};

  const previewFingerprint =
    optionalPlainObject(safeBody.previewFingerprint, "previewFingerprint") ||
    EMPTY_OBJECT;

  const editedField = normalizeRequiredText(
    safeBody.editedField ?? safeBody.field,
    "editedField",
    160,
  );
  const operation = normalizeText(safeBody.operation, "operation", 160);
  const editType = normalizeRequiredText(
    safeBody.editType ??
      safeBody.editedType ??
      CANONICAL_OPERATION_TO_LEGACY_EDIT_TYPE[operation],
    "editType",
    160,
  );
  const incomingEditValue = safeBody.editValue ?? safeBody.value;
  const rawEditValue =
    operation === "DECREASE_FIXED" &&
    incomingEditValue !== undefined &&
    incomingEditValue !== null &&
    String(incomingEditValue).trim() !== ""
      ? String(-Math.abs(Number(incomingEditValue)))
      : incomingEditValue;
  const searchKey = normalizeText(safeBody.searchKey, "searchKey", 300);
  const replaceText = normalizeText(
    safeBody.replaceText,
    "replaceText",
    MAX_LONG_TEXT_LENGTH,
  );

  if (SEARCH_REPLACE_EDIT_TYPES.has(editType) && !String(searchKey || "").trim()) {
    throw buildRequestError(
      "Search value is required for search/replace edits",
      "SEARCH_VALUE_REQUIRED",
    );
  }

  if (["price", "compareAtPrice"].includes(String(editedField || ""))) {
    if (rawEditValue === undefined || rawEditValue === null || String(rawEditValue).trim() === "") {
      throw buildRequestError("Enter a valid price.", "VALIDATION_FAILED", [
        { field: "value", error: "Value is required." },
      ]);
    }

    const numericValue = Number(rawEditValue);
    if (!Number.isFinite(numericValue)) {
      throw buildRequestError("Enter a valid price.", "VALIDATION_FAILED", [
        { field: "value", error: "Value must be a valid number." },
      ]);
    }

    if (editType === "Set to fixed value" && numericValue < 0) {
      throw buildRequestError("Enter a valid price.", "VALIDATION_FAILED", [
        { field: "value", error: "Value must be zero or greater." },
      ]);
    }
  }

  return Object.freeze({
    editedField,
    operation,
    editType,
    editValue: normalizeEditValue(
      rawEditValue,
      "editValue",
    ),
    searchKey,
    replaceText,
    supportValue: normalizeEditValue(safeBody.supportValue, "supportValue"),
    locationId: normalizeText(
      safeBody.locationId ?? safeBody.location,
      "locationId",
      200,
    ),
    rounding: normalizeText(safeBody.rounding, "rounding", 80) || "NONE",
    rawFilterInput: normalizeFilterParams(safeBody.rawFilterInput),
    filterAst: normalizeFilterAst(safeBody.filterAst),
    previewId: normalizeOptionalId(
      safeBody.previewId ?? safeBody.previewContractId,
      "previewId",
    ),
    previewFilterHash: normalizeText(
      safeBody.previewFilterHash ?? previewFingerprint.normalizedFilterHash,
      "previewFilterHash",
      500,
    ),
    previewMirrorBatchId: normalizeText(
      safeBody.previewMirrorBatchId ?? previewFingerprint.mirrorBatchId,
      "previewMirrorBatchId",
      200,
    ),
    previewSignature: normalizeText(
      safeBody.previewSignature,
      "previewSignature",
      500,
    ),
    previewFieldRegistryVersion: normalizeText(
      safeBody.previewFieldRegistryVersion ??
        previewFingerprint.fieldRegistryVersion,
      "previewFieldRegistryVersion",
      120,
    ),
    previewOperatorRegistryVersion: normalizeText(
      safeBody.previewOperatorRegistryVersion ??
        previewFingerprint.operatorRegistryVersion,
      "previewOperatorRegistryVersion",
      120,
    ),
    confirmBroadTarget: safeBody.confirmBroadTarget === true,
    criticalConfirmationText: normalizeText(
      safeBody.criticalConfirmationText,
      "criticalConfirmationText",
      500,
    ),
    operationKey: normalizeText(safeBody.operationKey, "operationKey", 200),
    productIds: normalizeProductIds(safeBody.productIds),
    title: normalizeText(safeBody.title, "title", 255),
    cursor: normalizeCursor(safeBody.cursor ?? safeQuery.cursor),
    page: normalizePage(safeBody.page ?? safeQuery.page),
    limit: normalizePreviewLimit(safeBody.limit ?? safeQuery.limit),
  });
}

function normalizeQueryObject(query) {
  return query && typeof query === "object" && !Array.isArray(query)
    ? query
    : EMPTY_OBJECT;
}

function requirePreviewContract(command) {
  if (!command.previewId) {
    throw buildRequestError("PREVIEW_ID_REQUIRED", "VALIDATION_FAILED");
  }
}

function assertNoLegacySchedulePayload(safeBody) {
  const legacyFields = [
    "editedField",
    "field",
    "editedBy",
    "editedType",
    "editType",
    "value",
    "editValue",
    "searchKey",
    "replaceText",
    "supportValue",
    "location",
    "locationId",
    "rawFilterInput",
    "filterAst",
    "productIds",
  ];

  const present = legacyFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(safeBody, field),
  );

  if (present.length > 0) {
    throw buildRequestError(
      `Scheduled edits must reference an approved preview contract; remove legacy fields: ${present.join(", ")}`,
      "LEGACY_SCHEDULE_PAYLOAD_FORBIDDEN",
    );
  }
}

function assertScheduledUndoAfterScheduledAt(scheduledAt, scheduledUndoAt) {
  if (!scheduledAt || !scheduledUndoAt) {
    return;
  }

  if (new Date(scheduledUndoAt).getTime() <= new Date(scheduledAt).getTime()) {
    throw buildRequestError(
      "Invalid scheduledUndoAt: must be after scheduledAt",
    );
  }
}

export function buildBulkEditPreviewCommand({
  body = {},
  query = {},
  context,
}) {
  const safeQuery = normalizeQueryObject(query);
  const safeContext = assertCommandContext(context);
  const payload = normalizeEditPayload({ body, query: safeQuery });

  return Object.freeze({
    ...safeContext,
    ...payload,
    lang: normalizeLang(safeQuery.lang),
  });
}

export function buildBulkEditExecuteCommand({
  body = {},
  query = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);
  const payload = normalizeEditPayload({ body, query });

  requirePreviewContract(payload);

  return Object.freeze({
    ...safeContext,
    ...payload,
    previewContractId: payload.previewId,
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildScheduledEditCommand({
  body = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);
  const safeBody = assertPlainObject(body, "body");
  assertNoLegacySchedulePayload(safeBody);

  const timezone = normalizeScheduleTimezone(safeBody.timezone);

  const scheduledAt = normalizeFutureUtcIsoDateString(
    safeBody.scheduledAt,
    "scheduledAt",
    true,
  );

  const scheduledUndoAt = normalizeFutureUtcIsoDateString(
    safeBody.scheduledUndoAt,
    "scheduledUndoAt",
    false,
  );

  assertScheduledUndoAfterScheduledAt(scheduledAt, scheduledUndoAt);

  return Object.freeze({
    ...safeContext,
    previewId: normalizeId(
      safeBody.previewContractId ?? safeBody.previewId,
      "previewContractId",
    ),
    previewContractId: normalizeId(
      safeBody.previewContractId ?? safeBody.previewId,
      "previewContractId",
    ),
    previewFilterHash: normalizeRequiredText(
      safeBody.previewFilterHash,
      "previewFilterHash",
      500,
    ),
    previewMirrorBatchId: normalizeRequiredText(
      safeBody.previewMirrorBatchId,
      "previewMirrorBatchId",
      200,
    ),
    previewFieldRegistryVersion: normalizeRequiredText(
      safeBody.previewFieldRegistryVersion,
      "previewFieldRegistryVersion",
      120,
    ),
    previewOperatorRegistryVersion: normalizeRequiredText(
      safeBody.previewOperatorRegistryVersion,
      "previewOperatorRegistryVersion",
      120,
    ),
    approvedTargetCount: normalizeCount(
      safeBody.approvedTargetCount,
      "approvedTargetCount",
    ),
    previewSignature: normalizeText(
      safeBody.previewSignature,
      "previewSignature",
      500,
    ),
    timezone,
    scheduleConfirmationText: normalizeText(
      safeBody.scheduleConfirmationText,
      "scheduleConfirmationText",
      80,
    ),
    scheduledAt,
    scheduledUndoAt,
    freezeMode: normalizeFreezeMode(safeBody.freezeMode),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildUndoEditCommand({
  params = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  return Object.freeze({
    ...safeContext,
    historyId: normalizeId(params.id, "historyId"),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildCancelEditCommand({
  params = {},
  body = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);
  const safeBody =
    body === undefined || body === null
      ? EMPTY_OBJECT
      : assertPlainObject(body, "body");

  return Object.freeze({
    ...safeContext,
    historyId: normalizeId(params.id, "historyId"),
    reason: normalizeCancelReason(safeBody.cancelReason),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildPauseEditCommand({
  params = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  return Object.freeze({
    ...safeContext,
    historyId: normalizeId(params.id, "historyId"),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildResumeEditCommand({
  params = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  return Object.freeze({
    ...safeContext,
    historyId: normalizeId(params.id, "historyId"),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildRetryFailedOnlyCommand({
  params = {},
  headers = {},
  context,
}) {
  const safeContext = assertCommandContext(context);

  return Object.freeze({
    ...safeContext,
    historyId: normalizeId(params.id, "historyId"),
    idempotencyKey: normalizeIdempotencyKey(headers),
  });
}

export function buildPreviewVariantDetailsCommand({
  params = {},
  query = {},
  context,
}) {
  const safeContext = assertCommandContext(context);
  const safeQuery = normalizeQueryObject(query);

  return Object.freeze({
    ...safeContext,
    previewId: normalizeId(params.previewId, "previewId"),
    productId: normalizeId(params.productId, "productId"),
    page: normalizeLimit(safeQuery.page) || 1,
    limit: normalizeLimit(safeQuery.limit) || 50,
  });
}
