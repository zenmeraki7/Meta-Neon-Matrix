const FILTER_COMBINATION_ID_MAX_LENGTH = 128;
const FILTER_COMBINATION_QUERY_KEYS = new Set(["limit", "cursor", "search"]);

const MAX_SEARCH_LENGTH = 120;
const MAX_CURSOR_LENGTH = 500;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;

const MAX_FILTER_JSON_BYTES = 64_000;
const MAX_ROOT_FILTER_CONDITIONS = 100;
const MAX_TOTAL_FILTER_CONDITIONS = 500;
const MAX_FILTER_DEPTH = 20;

const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const IF_MATCH_MAX_LENGTH = 200;

const BODY_KEYS = new Set(["title", "description", "filters"]);

function buildRequestError(message, code = "VALIDATION_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw buildRequestError(message);
  }

  return value;
}

function assertNoUnknownKeys(value, allowedKeys, label) {
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));

  if (unknownKeys.length > 0) {
    throw buildRequestError(`Invalid ${label} keys: ${unknownKeys.join(",")}`);
  }
}

function normalizeTextValue(value) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearch(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value !== "string") {
    throw buildRequestError("Invalid search: must be a string");
  }

  return normalizeTextValue(value);
}

function normalizeRequiredText(value, fieldName) {
  if (typeof value !== "string") {
    throw buildRequestError(`Invalid ${fieldName}: must be a string`);
  }

  return normalizeTextValue(value);
}

function normalizeOptionalText(value, fieldName, defaultValue = "") {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value !== "string") {
    throw buildRequestError(`Invalid ${fieldName}: must be a string`);
  }

  return normalizeTextValue(value);
}

function assertOptionalString(value, fieldName, defaultValue = "") {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  if (typeof value !== "string") {
    throw buildRequestError(`Invalid ${fieldName}: must be a string`);
  }

  return value;
}

function assertJsonSize(value, maxBytes, label) {
  let bytes;

  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw buildRequestError(`Invalid ${label}: must be valid JSON`);
  }

  if (bytes > maxBytes) {
    throw buildRequestError(`${label} is too large`);
  }
}

function requireIdempotencyKey(getHeader) {
  const idempotencyKey = getHeader("Idempotency-Key")?.trim();

  if (!idempotencyKey) {
    throw buildRequestError(
      "Idempotency-Key header is required",
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  }

  if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw buildRequestError("Idempotency-Key header is too long");
  }

  return idempotencyKey;
}

function requireIfMatchHeader(getHeader) {
  const value = getHeader("If-Match")?.trim();

  if (!value) {
    throw buildRequestError(
      "If-Match header is required",
      "PRECONDITION_REQUIRED",
    );
  }

  if (value.length > IF_MATCH_MAX_LENGTH) {
    throw buildRequestError("Invalid If-Match header");
  }

  return value;
}

function validateId(rawId) {
  const id = typeof rawId === "string" ? rawId.trim() : "";

  if (!id || id.length > FILTER_COMBINATION_ID_MAX_LENGTH) {
    throw buildRequestError("Invalid filter combination id");
  }

  // Allows app ids, CUID-style ids, UUID-like ids, and gid-ish internal aliases.
  // If your DB id format is fixed, replace this with the exact DB id regex.
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw buildRequestError("Invalid filter combination id");
  }

  return id;
}

function validateListQuery(rawQuery = {}) {
  rawQuery = assertPlainObject(rawQuery, "Invalid query");

  assertNoUnknownKeys(rawQuery, FILTER_COMBINATION_QUERY_KEYS, "query");

  const search = normalizeSearch(rawQuery.search);

  if (search.length > MAX_SEARCH_LENGTH) {
    throw buildRequestError(
      `Invalid query: search must be <= ${MAX_SEARCH_LENGTH} chars`,
    );
  }

  const rawLimit = assertOptionalString(rawQuery.limit, "limit", "");
  const limit = rawLimit === "" ? DEFAULT_LIST_LIMIT : Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw buildRequestError(
      `Invalid query: limit must be an integer between 1 and ${MAX_LIST_LIMIT}`,
    );
  }

  const rawCursor = assertOptionalString(rawQuery.cursor, "cursor", "");
  const cursor = rawCursor.trim() ? rawCursor.trim() : undefined;

  if (cursor && cursor.length > MAX_CURSOR_LENGTH) {
    throw buildRequestError(
      `Invalid query: cursor must be <= ${MAX_CURSOR_LENGTH} chars`,
    );
  }

  return Object.freeze({
    limit,
    cursor,
    search,
  });
}

/**
 * Request-boundary validation only.
 *
 * This intentionally validates only:
 * - JSON envelope shape
 * - size limits
 * - max nesting
 * - max condition count
 * - logic token shape
 * - empty group rejection
 *
 * It must NOT validate supported fields/operators, compile SQL/Prisma filters,
 * resolve product targets, inspect mirror batches, or decide targeting semantics.
 * Those belong in the filter/domain/targeting service.
 */
function assertFilterGroupEnvelope(
  group,
  depth = 0,
  state = { conditionCount: 0 },
) {
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    throw buildRequestError("Invalid filters: group must be an object");
  }

  if (depth > MAX_FILTER_DEPTH) {
    throw buildRequestError("Invalid filters: maximum nesting depth exceeded");
  }

  if (
    Object.prototype.hasOwnProperty.call(group, "logic") &&
    !["AND", "OR"].includes(group.logic)
  ) {
    throw buildRequestError("Invalid filters: logic must be AND or OR");
  }

  if (!Array.isArray(group.conditions)) {
    throw buildRequestError("Invalid filters: conditions array is required");
  }

  if (group.conditions.length === 0) {
    throw buildRequestError("Invalid filters: conditions array must not be empty");
  }

  if (depth === 0 && group.conditions.length > MAX_ROOT_FILTER_CONDITIONS) {
    throw buildRequestError("Invalid filters: too many root conditions");
  }

  for (const condition of group.conditions) {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
      throw buildRequestError("Invalid filters: condition must be an object");
    }

    if (Array.isArray(condition.conditions)) {
      assertFilterGroupEnvelope(condition, depth + 1, state);
      continue;
    }

    state.conditionCount += 1;

    if (state.conditionCount > MAX_TOTAL_FILTER_CONDITIONS) {
      throw buildRequestError("Invalid filters: too many total conditions");
    }
  }

  return state;
}

function requireFilterAstEnvelope(filters) {
  filters = assertPlainObject(filters, "Invalid filters");

  assertJsonSize(filters, MAX_FILTER_JSON_BYTES, "filters");
  assertFilterGroupEnvelope(filters);

  return filters;
}

function validateCreateBody(rawBody = {}) {
  rawBody = assertPlainObject(rawBody, "Invalid body");

  assertNoUnknownKeys(rawBody, BODY_KEYS, "body");

  const title = normalizeRequiredText(rawBody.title, "title");

  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw buildRequestError(
      `Invalid body: title is required and must be <= ${MAX_TITLE_LENGTH} chars`,
    );
  }

  const description = Object.prototype.hasOwnProperty.call(rawBody, "description")
    ? normalizeOptionalText(rawBody.description, "description", "")
    : "";

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw buildRequestError(
      `Invalid body: description must be <= ${MAX_DESCRIPTION_LENGTH} chars`,
    );
  }

  return Object.freeze({
    title,
    description,
    filters: requireFilterAstEnvelope(rawBody.filters),
  });
}

function validateUpdateBody(rawBody = {}) {
  rawBody = assertPlainObject(rawBody, "Invalid body");

  assertNoUnknownKeys(rawBody, BODY_KEYS, "body");

  const patch = {};

  if (Object.prototype.hasOwnProperty.call(rawBody, "title")) {
    const title = normalizeRequiredText(rawBody.title, "title");

    if (!title || title.length > MAX_TITLE_LENGTH) {
      throw buildRequestError(
        `Invalid body: title must be 1-${MAX_TITLE_LENGTH} chars`,
      );
    }

    patch.title = title;
  }

  if (Object.prototype.hasOwnProperty.call(rawBody, "description")) {
    const description = normalizeOptionalText(
      rawBody.description,
      "description",
      "",
    );

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw buildRequestError(
        `Invalid body: description must be <= ${MAX_DESCRIPTION_LENGTH} chars`,
      );
    }

    patch.description = description;
  }

  if (Object.prototype.hasOwnProperty.call(rawBody, "filters")) {
    patch.filters = requireFilterAstEnvelope(rawBody.filters);
  }

  if (Object.keys(patch).length === 0) {
    throw buildRequestError("Invalid body: at least one field is required");
  }

  return Object.freeze(patch);
}

function assertCommandContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw buildRequestError("Invalid command context");
  }

  if (!context.shop || typeof context.shop !== "string") {
    throw buildRequestError("Authentication required", "UNAUTHENTICATED");
  }

  return Object.freeze({
    shop: context.shop,
    actor: context.actor || null,
    entitlement: context.entitlement || null,
    subscription: context.subscription || null,
  });
}

function assertGetHeader(getHeader) {
  if (typeof getHeader !== "function") {
    throw buildRequestError("Invalid request header reader");
  }

  return getHeader;
}

function assertParamsObject(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw buildRequestError("Invalid params");
  }

  return params;
}

export function buildAddFilterCombinationCommand({
  body,
  context,
  getHeader,
}) {
  const safeContext = assertCommandContext(context);
  const safeGetHeader = assertGetHeader(getHeader);
  const safeBody = validateCreateBody(body);

  return Object.freeze({
    ...safeContext,
    idempotencyKey: requireIdempotencyKey(safeGetHeader),
    title: safeBody.title,
    description: safeBody.description,
    filters: safeBody.filters,
  });
}

export function buildListFilterCombinationsCommand({
  query,
  context,
}) {
  const safeContext = assertCommandContext(context);
  const safeQuery = validateListQuery(query);

  return Object.freeze({
    ...safeContext,
    limit: safeQuery.limit,
    cursor: safeQuery.cursor,
    search: safeQuery.search,
  });
}

export function buildUpdateFilterCombinationCommand({
  params,
  body,
  context,
  getHeader,
}) {
  const safeParams = assertParamsObject(params);
  const safeContext = assertCommandContext(context);
  const safeGetHeader = assertGetHeader(getHeader);

  return Object.freeze({
    ...safeContext,
    id: validateId(safeParams.id),
    idempotencyKey: requireIdempotencyKey(safeGetHeader),
    expectedUpdatedAt: requireIfMatchHeader(safeGetHeader),
    patch: validateUpdateBody(body),
  });
}

export function buildDeleteFilterCombinationCommand({
  params,
  context,
  getHeader,
}) {
  const safeParams = assertParamsObject(params);
  const safeContext = assertCommandContext(context);
  const safeGetHeader = assertGetHeader(getHeader);

  return Object.freeze({
    ...safeContext,
    id: validateId(safeParams.id),
    idempotencyKey: requireIdempotencyKey(safeGetHeader),
  });
}
