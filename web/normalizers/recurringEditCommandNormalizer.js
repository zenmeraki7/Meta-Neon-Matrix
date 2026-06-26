const MAX_ID_LENGTH = 255;
const MAX_SEARCH_LENGTH = 255;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_STRING_LENGTH = 10_000;
const MAX_SHORT_STRING_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_CURSOR_LENGTH = 1_000;
const MAX_OBJECT_DEPTH = 8;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 100;
const MAX_FILTER_PARAMS = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;
const MAX_TIMEZONE_LENGTH = 100;

const ALLOWED_RECURRING_STATUSES = Object.freeze([
  "ACTIVE",
  "PAUSED",
  "DISABLED",
]);

const ALLOWED_LIST_STATUSES = Object.freeze([
  "",
  "ACTIVE",
  "PAUSED",
  "DISABLED",
  "DELETED",
  "FAILED",
]);

const ALLOWED_FREQUENCIES = Object.freeze([
  "",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "CUSTOM",
  "EVERY_X_MINUTES",
]);

const PROHIBITED_OBJECT_KEYS = Object.freeze([
  "__proto__",
  "prototype",
  "constructor",
]);

const PROHIBITED_REQUEST_KEYS = Object.freeze([
  "shop",
  "shopDomain",
  "myshopifyDomain",
  "ownerShop",
  "store",
]);

function buildCommandError(code, message = code, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date),
  );
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

function safeString(value, fallback = null, maxLength = MAX_STRING_LENGTH) {
  if (value === undefined || value === null) return fallback;

  const stringValue = String(value).trim();

  if (!stringValue) return fallback;

  return stringValue.length > maxLength
    ? stringValue.slice(0, maxLength)
    : stringValue;
}

function safeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }

  return fallback;
}

function safeInteger(value, fallback = null, { min = null, max = null } = {}) {
  if (value === undefined || value === null || value === "") return fallback;

  const number = Number(value);

  if (!Number.isInteger(number)) return fallback;
  if (min !== null && number < min) return fallback;
  if (max !== null && number > max) return fallback;

  return number;
}

function normalizeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function normalizeDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function assertPlainObjectOrEmpty(value, code, message) {
  if (value === undefined || value === null) return {};

  if (!isPlainObject(value)) {
    throw buildCommandError(code, message);
  }

  return value;
}

function assertNoRequestShopOverride(source, sourceName) {
  if (!isPlainObject(source)) return;

  for (const key of PROHIBITED_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      throw buildCommandError(
        "SHOP_OVERRIDE_REJECTED",
        `${sourceName}.${key} is not allowed`,
        { field: `${sourceName}.${key}` },
      );
    }
  }
}

function requireShop(shop) {
  const normalizedShop = safeString(shop, null, MAX_ID_LENGTH);

  if (!normalizedShop) {
    throw buildCommandError("SHOP_REQUIRED", "Authenticated shop is required");
  }

  return normalizedShop;
}

function requireId(value, code, message) {
  const id = safeString(value, null, MAX_ID_LENGTH);

  if (!id) {
    throw buildCommandError(code, message);
  }

  return id;
}

function requireIdempotencyKey(idempotencyKey, actionName) {
  const normalizedKey = safeString(
    idempotencyKey,
    null,
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );

  if (!normalizedKey) {
    throw buildCommandError(
      "IDEMPOTENCY_KEY_REQUIRED",
      `Idempotency-Key header is required for ${actionName}`,
    );
  }

  return normalizedKey;
}

function requireActor(actor) {
  if (!isPlainObject(actor)) {
    throw buildCommandError("ACTOR_REQUIRED", "Actor context is required");
  }

  const normalizedActor = {
    type: safeString(actor.type, null, 100),
    userId: safeString(actor.userId, null, MAX_ID_LENGTH),
    email: safeString(actor.email, null, MAX_EMAIL_LENGTH),
    name: safeString(actor.name, null, MAX_ID_LENGTH),
  };

  if (!normalizedActor.type) {
    throw buildCommandError("ACTOR_TYPE_REQUIRED", "Actor type is required");
  }

  return Object.freeze(normalizedActor);
}

function normalizeSubscription(subscription) {
  if (!subscription) return null;

  if (!isPlainObject(subscription)) {
    throw buildCommandError(
      "INVALID_SUBSCRIPTION_CONTEXT",
      "Subscription context is invalid",
    );
  }

  return Object.freeze({
    plan: safeString(subscription.plan, null, 100),
    status: safeString(subscription.status, null, 100),
    cappedAmount: normalizeNumber(subscription.cappedAmount),
    trialEndsAt: normalizeDate(subscription.trialEndsAt),
  });
}

function normalizeRunTime(value) {
  const input = safeString(value, null, MAX_SHORT_STRING_LENGTH);

  if (!input) return null;

  let match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input);
  if (match) return `${match[1]}:${match[2]}`;

  match = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*([AaPp][Mm])$/.exec(input);
  if (!match) {
    throw buildCommandError(
      "INVALID_RECURRING_RUN_TIME",
      "Recurring edit run time must be a valid time",
      { field: "runTime" },
    );
  }

  const hour12 = Number(match[1]);
  const hour =
    match[3].toUpperCase() === "AM"
      ? hour12 % 12
      : hour12 === 12
        ? 12
        : hour12 + 12;

  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

function normalizeDateString(value, fieldName) {
  const input = safeString(value, null, MAX_SHORT_STRING_LENGTH);

  if (!input) return null;

  const date = new Date(input);

  if (Number.isNaN(date.getTime())) {
    throw buildCommandError(
      "INVALID_DATE",
      `${fieldName} must be a valid date`,
      { field: fieldName },
    );
  }

  return date.toISOString();
}

function normalizeOptionalDateString(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeDateString(value, fieldName);
}

function normalizeTimezone(value) {
  const timezone = safeString(value, null, MAX_TIMEZONE_LENGTH);

  if (!timezone) return null;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return timezone;
  } catch {
    throw buildCommandError(
      "INVALID_TIMEZONE",
      "Recurring edit timezone is invalid",
      { timezone },
    );
  }
}

function sanitizeJsonValue(value, depth = 0) {
  if (depth > MAX_OBJECT_DEPTH) {
    throw buildCommandError(
      "PAYLOAD_TOO_DEEP",
      "Recurring edit payload exceeds maximum nesting depth",
    );
  }

  if (value === undefined || value === null) return null;

  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? value.slice(0, MAX_STRING_LENGTH)
      : value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeJsonValue(item, depth + 1));
  }

  if (isPlainObject(value)) {
    const output = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);

    for (const [key, nestedValue] of entries) {
      if (PROHIBITED_OBJECT_KEYS.includes(key)) continue;

      const safeKey = safeString(key, null, MAX_SHORT_STRING_LENGTH);
      if (!safeKey) continue;

      output[safeKey] = sanitizeJsonValue(nestedValue, depth + 1);
    }

    return output;
  }

  return safeString(value);
}

function normalizeFilterParams(value) {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) {
    throw buildCommandError(
      "INVALID_FILTER_PARAMS",
      "filterParams must be an array",
    );
  }

  return value.slice(0, MAX_FILTER_PARAMS).map((filter, index) => {
    if (!isPlainObject(filter)) {
      throw buildCommandError(
        "INVALID_FILTER_PARAM",
        "Each filterParams item must be an object",
        { index },
      );
    }

    return sanitizeJsonValue(filter);
  });
}

function normalizeFilterAst(value) {
  if (value === undefined || value === null || value === "") return null;

  if (!isPlainObject(value)) {
    throw buildCommandError(
      "INVALID_FILTER_AST",
      "filterAst must be an object",
    );
  }

  return sanitizeJsonValue(value);
}

function normalizeEditPayload(value) {
  if (value === undefined || value === null) return {};

  if (!isPlainObject(value)) {
    throw buildCommandError(
      "INVALID_EDIT_PAYLOAD",
      "Recurring edit payload must be an object",
    );
  }

  return sanitizeJsonValue(value);
}

function normalizeFrequency(value, fallback = null) {
  const frequency = safeString(value, fallback, 100)?.toUpperCase() || "";

  if (!ALLOWED_FREQUENCIES.includes(frequency)) {
    throw buildCommandError(
      "INVALID_RECURRING_FREQUENCY",
      "Recurring edit frequency is invalid",
      { frequency },
    );
  }

  return frequency;
}

function normalizeListStatus(value) {
  const status = safeString(value, "", 100)?.toUpperCase() || "";

  if (!ALLOWED_LIST_STATUSES.includes(status)) {
    throw buildCommandError(
      "INVALID_RECURRING_EDIT_STATUS",
      "Recurring edit status filter is invalid",
      { status },
    );
  }

  return status;
}

function normalizeMutationStatus(value) {
  const status = safeString(value, null, 100)?.toUpperCase();

  if (!status || !ALLOWED_RECURRING_STATUSES.includes(status)) {
    throw buildCommandError(
      "INVALID_RECURRING_EDIT_STATUS",
      "Recurring edit status is invalid",
      { status },
    );
  }

  return status;
}

function assertCursorPaginationOnly(query) {
  if (query?.page && String(query.page) !== "1") {
    throw buildCommandError(
      "OFFSET_PAGINATION_DISABLED",
      "Offset pagination is disabled. Use cursor pagination.",
    );
  }
}

function resolveStartsAt(body) {
  return (
    body?.startsAt ||
    body?.startAt ||
    body?.schedule?.startsAt ||
    body?.schedule?.startAt ||
    null
  );
}

function resolveEndsAt(body) {
  return (
    body?.endsAt ||
    body?.endAt ||
    body?.schedule?.endsAt ||
    body?.schedule?.endAt ||
    null
  );
}

function resolveFrequency(body) {
  return (
    body?.frequency ||
    body?.recurrenceFrequency ||
    body?.schedule?.frequency ||
    body?.recurrence?.frequency ||
    null
  );
}

function resolveTimezone(body) {
  return body?.timezone || body?.schedule?.timezone || null;
}

function resolveTimeToRun(body) {
  return (
    body?.runTime ||
    body?.timeToRun ||
    body?.schedule?.runTime ||
    body?.schedule?.timeToRun ||
    body?.schedule?.time ||
    null
  );
}

function resolveIntervalMinutes(body) {
  return body?.intervalMinutes || body?.schedule?.intervalMinutes || null;
}

function resolveEditPayload(body) {
  if (body?.editPayload !== undefined) return body.editPayload;
  if (body?.editCommand !== undefined) return body.editCommand;
  if (
    body?.operation &&
    typeof body.operation === "object" &&
    !Array.isArray(body.operation)
  ) {
    return body.operation;
  }
  if (body?.bulkEdit !== undefined) return body.bulkEdit;

  return (
    {}
  );
}

function assertNoConflictingScheduleFields(body) {
  const topLevelStartsAt = body?.startsAt || body?.startAt || null;
  const nestedStartsAt = body?.schedule?.startsAt || body?.schedule?.startAt || null;

  const topLevelEndsAt = body?.endsAt || body?.endAt || null;
  const nestedEndsAt = body?.schedule?.endsAt || body?.schedule?.endAt || null;

  const topLevelFrequency = body?.frequency || body?.recurrenceFrequency || null;
  const nestedFrequency = body?.schedule?.frequency || body?.recurrence?.frequency || null;

  const topLevelTimezone = body?.timezone || null;
  const nestedTimezone = body?.schedule?.timezone || null;

  const conflicts = [];

  if (
    topLevelStartsAt &&
    nestedStartsAt &&
    String(topLevelStartsAt) !== String(nestedStartsAt)
  ) {
    conflicts.push("startsAt");
  }

  if (
    topLevelEndsAt &&
    nestedEndsAt &&
    String(topLevelEndsAt) !== String(nestedEndsAt)
  ) {
    conflicts.push("endsAt");
  }

  if (
    topLevelFrequency &&
    nestedFrequency &&
    String(topLevelFrequency).toUpperCase() !== String(nestedFrequency).toUpperCase()
  ) {
    conflicts.push("frequency");
  }

  if (
    topLevelTimezone &&
    nestedTimezone &&
    String(topLevelTimezone) !== String(nestedTimezone)
  ) {
    conflicts.push("timezone");
  }

  if (conflicts.length > 0) {
    throw buildCommandError(
      "CONFLICTING_RECURRING_SCHEDULE_FIELDS",
      "Recurring edit schedule fields contain conflicting values",
      { fields: conflicts },
    );
  }
}

function normalizeRecurringEditBody(body, { partial = false } = {}) {
  const safeBody = assertPlainObjectOrEmpty(
    body,
    "INVALID_RECURRING_EDIT_BODY",
    "Recurring edit body must be an object",
  );

  assertNoRequestShopOverride(safeBody, "body");
  assertNoConflictingScheduleFields(safeBody);

  const name =
    safeBody.name === undefined && safeBody.title === undefined
      ? null
      : safeString(
          safeBody.name ?? safeBody.title,
          null,
          MAX_SHORT_STRING_LENGTH,
        );

  const startsAt = normalizeOptionalDateString(
    resolveStartsAt(safeBody),
    "startsAt",
  );

  const endsAt = normalizeOptionalDateString(resolveEndsAt(safeBody), "endsAt");

  const frequency = normalizeFrequency(
    resolveFrequency(safeBody),
    partial ? "" : null,
  );

  const timezone = normalizeTimezone(resolveTimezone(safeBody));

  if (!partial && !name) {
    throw buildCommandError(
      "RECURRING_EDIT_NAME_REQUIRED",
      "Recurring edit name is required",
    );
  }

  if (!partial && !frequency) {
    throw buildCommandError(
      "RECURRING_FREQUENCY_REQUIRED",
      "Recurring edit frequency is required",
    );
  }

  if (
    startsAt &&
    endsAt &&
    new Date(endsAt).getTime() <= new Date(startsAt).getTime()
  ) {
    throw buildCommandError(
      "INVALID_RECURRING_DATE_RANGE",
      "Recurring edit end date must be after start date",
    );
  }

  const normalized = {
    name,
    title: name,
    description:
      safeBody.description === undefined
        ? null
        : safeString(safeBody.description, null, MAX_DESCRIPTION_LENGTH),

    frequency: frequency || null,
    scheduleType: frequency || null,
    timezone,
    timeToRun: normalizeRunTime(resolveTimeToRun(safeBody)),
    runTime: normalizeRunTime(resolveTimeToRun(safeBody)),
    startsAt,
    startAt: startsAt,
    endsAt,
    endAt: endsAt,
    intervalMinutes: safeInteger(resolveIntervalMinutes(safeBody), null, {
      min: 1,
      max: 24 * 60,
    }),
    status:
      safeBody.status === undefined
        ? null
        : normalizeMutationStatus(safeBody.status),
    uiFrequency:
      safeBody.uiFrequency === undefined
        ? null
        : safeString(safeBody.uiFrequency, null, MAX_SHORT_STRING_LENGTH),
    daysOfWeekToRun:
      safeBody.daysOfWeekToRun === undefined
        ? null
        : sanitizeJsonValue(safeBody.daysOfWeekToRun),
    dayOfMonthToRun:
      safeBody.dayOfMonthToRun === undefined
        ? null
        : safeInteger(safeBody.dayOfMonthToRun, null, { min: 1, max: 31 }),
    approvedPreviewCount:
      safeBody.approvedPreviewCount === undefined
        ? null
        : safeInteger(safeBody.approvedPreviewCount, null, {
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
          }),
    filterFingerprint:
      safeBody.filterFingerprint === undefined
        ? null
        : safeString(safeBody.filterFingerprint, null, MAX_ID_LENGTH),
    targetingFingerprint:
      safeBody.targetingFingerprint === undefined
        ? null
        : safeString(safeBody.targetingFingerprint, null, MAX_ID_LENGTH),
    previewContractId:
      safeBody.previewContractId === undefined && safeBody.previewId === undefined
        ? null
        : safeString(
            safeBody.previewContractId ?? safeBody.previewId,
            null,
            MAX_ID_LENGTH,
          ),
    previewId:
      safeBody.previewContractId === undefined && safeBody.previewId === undefined
        ? null
        : safeString(
            safeBody.previewId ?? safeBody.previewContractId,
            null,
            MAX_ID_LENGTH,
          ),
    previewFilterHash:
      safeBody.previewFilterHash === undefined
        ? null
        : safeString(safeBody.previewFilterHash, null, MAX_ID_LENGTH),
    previewMirrorBatchId:
      safeBody.previewMirrorBatchId === undefined
        ? null
        : safeString(safeBody.previewMirrorBatchId, null, MAX_ID_LENGTH),
    previewFieldRegistryVersion:
      safeBody.previewFieldRegistryVersion === undefined
        ? null
        : safeString(
            safeBody.previewFieldRegistryVersion,
            null,
            MAX_SHORT_STRING_LENGTH,
          ),
    previewOperatorRegistryVersion:
      safeBody.previewOperatorRegistryVersion === undefined
        ? null
        : safeString(
            safeBody.previewOperatorRegistryVersion,
            null,
            MAX_SHORT_STRING_LENGTH,
          ),
    previewSignature:
      safeBody.previewSignature === undefined
        ? null
        : safeString(safeBody.previewSignature, null, MAX_ID_LENGTH),
    operationKey:
      safeBody.operationKey === undefined
        ? null
        : safeString(safeBody.operationKey, null, MAX_ID_LENGTH),
    editedField:
      safeBody.editedField === undefined
        ? null
        : safeString(safeBody.editedField, null, MAX_SHORT_STRING_LENGTH),
    field:
      safeBody.field === undefined
        ? null
        : safeString(safeBody.field, null, MAX_SHORT_STRING_LENGTH),
    editedBy:
      safeBody.editedBy === undefined
        ? null
        : safeString(safeBody.editedBy, null, MAX_SHORT_STRING_LENGTH),
    operation:
      safeBody.operation === undefined
        ? null
        : safeString(safeBody.operation, null, MAX_SHORT_STRING_LENGTH),
    editType:
      safeBody.editType === undefined
        ? null
        : safeString(safeBody.editType, null, MAX_SHORT_STRING_LENGTH),
    editedType:
      safeBody.editedType === undefined
        ? null
        : safeString(safeBody.editedType, null, MAX_SHORT_STRING_LENGTH),
    value:
      safeBody.value === undefined ? null : sanitizeJsonValue(safeBody.value),
    searchKey:
      safeBody.searchKey === undefined
        ? null
        : safeString(safeBody.searchKey, null, MAX_SHORT_STRING_LENGTH),
    replaceText:
      safeBody.replaceText === undefined
        ? null
        : safeString(safeBody.replaceText, null, MAX_STRING_LENGTH),
    supportValue:
      safeBody.supportValue === undefined
        ? null
        : sanitizeJsonValue(safeBody.supportValue),
    locationId:
      safeBody.locationId === undefined
        ? null
        : safeString(safeBody.locationId, null, MAX_ID_LENGTH),
    rules:
      safeBody.rules === undefined ? null : sanitizeJsonValue(safeBody.rules),
    createdAt:
      safeBody.createdAt === undefined
        ? null
        : normalizeOptionalDateString(safeBody.createdAt, "createdAt"),

    filterParams:
      safeBody.filterParams === undefined
        ? null
        : normalizeFilterParams(safeBody.filterParams),

    filterAst:
      safeBody.filterAst === undefined
        ? null
        : normalizeFilterAst(safeBody.filterAst),

    editPayload:
      resolveEditPayload(safeBody) === undefined
        ? null
        : normalizeEditPayload(resolveEditPayload(safeBody)),

    schedule:
      safeBody.schedule === undefined ? null : sanitizeJsonValue(safeBody.schedule),

    recurrence:
      safeBody.recurrence === undefined
        ? null
        : sanitizeJsonValue(safeBody.recurrence),

    dryRun:
      safeBody.dryRun === undefined ? null : safeBoolean(safeBody.dryRun, false),
  };

  if (partial) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(normalized).filter(([, value]) => value !== null),
      ),
    );
  }

  return Object.freeze({
    ...normalized,
    filterParams: normalized.filterParams || [],
    editPayload: normalized.editPayload || {},
    dryRun: normalized.dryRun ?? false,
  });
}

export function buildCreateRecurringEditCommand({
  shop,
  actor,
  body,
  subscription,
  idempotencyKey,
}) {
  return deepFreeze({
    shop: requireShop(shop),
    actor: requireActor(actor),
    commandType: "CREATE_RECURRING_EDIT",
    idempotencyKey: requireIdempotencyKey(
      idempotencyKey,
      "create recurring edit",
    ),
    subscription: normalizeSubscription(subscription),
    input: normalizeRecurringEditBody(body),
    requestedAt: new Date().toISOString(),
  });
}

export function buildListRecurringEditsCommand({ shop, actor, query }) {
  const safeQuery = assertPlainObjectOrEmpty(
    query,
    "INVALID_RECURRING_EDIT_QUERY",
    "Recurring edit query must be an object",
  );

  assertNoRequestShopOverride(safeQuery, "query");
  assertCursorPaginationOnly(safeQuery);

  return deepFreeze({
    shop: requireShop(shop),
    actor: requireActor(actor),
    cursor: safeString(safeQuery.cursor, null, MAX_CURSOR_LENGTH),
    limit: safeInteger(safeQuery.limit, DEFAULT_LIMIT, {
      min: 1,
      max: MAX_LIMIT,
    }),
    search: safeString(safeQuery.search, "", MAX_SEARCH_LENGTH) || "",
    status: normalizeListStatus(safeQuery.status),
    frequency: normalizeFrequency(safeQuery.frequency, ""),
  });
}

export function buildGetRecurringEditCommand({ shop, actor, params }) {
  const safeParams = assertPlainObjectOrEmpty(
    params,
    "INVALID_RECURRING_EDIT_PARAMS",
    "Recurring edit params must be an object",
  );

  assertNoRequestShopOverride(safeParams, "params");

  return deepFreeze({
    shop: requireShop(shop),
    actor: requireActor(actor),
    recurringEditId: requireId(
      safeParams.id,
      "RECURRING_EDIT_ID_REQUIRED",
      "Recurring edit id is required",
    ),
  });
}

export function buildUpdateRecurringEditCommand({
  shop,
  actor,
  params,
  body,
  subscription,
  idempotencyKey,
}) {
  const safeParams = assertPlainObjectOrEmpty(
    params,
    "INVALID_RECURRING_EDIT_PARAMS",
    "Recurring edit params must be an object",
  );

  assertNoRequestShopOverride(safeParams, "params");

  const patch = normalizeRecurringEditBody(body, { partial: true });

  if (Object.keys(patch).length === 0) {
    throw buildCommandError(
      "RECURRING_EDIT_PATCH_EMPTY",
      "At least one recurring edit field is required for update",
    );
  }

  return deepFreeze({
    shop: requireShop(shop),
    actor: requireActor(actor),
    recurringEditId: requireId(
      safeParams.id,
      "RECURRING_EDIT_ID_REQUIRED",
      "Recurring edit id is required",
    ),
    commandType: "UPDATE_RECURRING_EDIT",
    idempotencyKey: requireIdempotencyKey(
      idempotencyKey,
      "update recurring edit",
    ),
    subscription: normalizeSubscription(subscription),
    patch,
    requestedAt: new Date().toISOString(),
  });
}

export function buildToggleRecurringEditStatusCommand({
  shop,
  actor,
  params,
  body,
  subscription,
  idempotencyKey,
}) {
  const safeParams = assertPlainObjectOrEmpty(
    params,
    "INVALID_RECURRING_EDIT_PARAMS",
    "Recurring edit params must be an object",
  );

  const safeBody = assertPlainObjectOrEmpty(
    body,
    "INVALID_RECURRING_EDIT_BODY",
    "Recurring edit body must be an object",
  );

  assertNoRequestShopOverride(safeParams, "params");
  assertNoRequestShopOverride(safeBody, "body");

  return deepFreeze({
    shop: requireShop(shop),
    actor: requireActor(actor),
    recurringEditId: requireId(
      safeParams.id,
      "RECURRING_EDIT_ID_REQUIRED",
      "Recurring edit id is required",
    ),
    commandType: "TOGGLE_RECURRING_EDIT_STATUS",
    idempotencyKey: requireIdempotencyKey(
      idempotencyKey,
      "toggle recurring edit status",
    ),
    subscription: normalizeSubscription(subscription),
    status: normalizeMutationStatus(safeBody.status),
    requestedAt: new Date().toISOString(),
  });
}

export function buildDeleteRecurringEditCommand({
  shop,
  actor,
  params,
  idempotencyKey,
}) {
  const safeParams = assertPlainObjectOrEmpty(
    params,
    "INVALID_RECURRING_EDIT_PARAMS",
    "Recurring edit params must be an object",
  );

  assertNoRequestShopOverride(safeParams, "params");

  return deepFreeze({
    shop: requireShop(shop),
    actor: requireActor(actor),
    recurringEditId: requireId(
      safeParams.id,
      "RECURRING_EDIT_ID_REQUIRED",
      "Recurring edit id is required",
    ),
    commandType: "DELETE_RECURRING_EDIT",
    idempotencyKey: requireIdempotencyKey(
      idempotencyKey,
      "delete recurring edit",
    ),
    requestedAt: new Date().toISOString(),
  });
}

export default {
  buildCreateRecurringEditCommand,
  buildListRecurringEditsCommand,
  buildGetRecurringEditCommand,
  buildUpdateRecurringEditCommand,
  buildToggleRecurringEditStatusCommand,
  buildDeleteRecurringEditCommand,
};
