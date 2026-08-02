function createValidationError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ensureObject(input, code) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createValidationError("Invalid request payload", code);
  }
  return input;
}

function rejectUnknownFields(input, allowed, code = "UNSUPPORTED_FIELD") {
  for (const key of Object.keys(input || {})) {
    if (!allowed.has(key)) {
      throw createValidationError(`Unsupported field: ${key}`, code);
    }
  }
}

function toStringOrNull(v) {
  if (v === null || v === undefined) return null;
  const next = String(v).trim();
  return next || null;
}

function toPositiveInt(v, fallback = 50, max = 100) {
  if (v === null || v === undefined || v === "") return fallback;
  const parsed = Number.parseInt(String(v), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function normalizePagination(query = {}, options = {}) {
  const {
    defaultLimit = 25,
    maxLimit = 100,
    allowedSorts = ["createdAt", "updatedAt", "status", "nextRunAt"],
  } = options;
  const sortKey = toStringOrNull(query.sortKey) || allowedSorts[0];
  if (!allowedSorts.includes(sortKey)) {
    throw createValidationError("Invalid sort key", "INVALID_SORT_KEY");
  }
  const sortDirection = (toStringOrNull(query.sortDirection) || "desc").toLowerCase();
  if (!["asc", "desc"].includes(sortDirection)) {
    throw createValidationError("Invalid sort direction", "INVALID_SORT_DIRECTION");
  }
  return {
    cursor: toStringOrNull(query.cursor),
    limit: toPositiveInt(query.limit, defaultLimit, maxLimit),
    sortKey,
    sortDirection,
  };
}

const CREATE_KEYS = new Set([
  "title",
  "description",
  "filterAst",
  "conditions",
  "rawFilterInput",
  "rules",
  "actions",
  "editedField",
  "trigger",
  "triggerType",
  "schedule",
  "scheduleType",
  "scheduleConfig",
  "cronExpression",
  "intervalMinutes",
  "timezone",
  "enabled",
  "status",
  "targetResourceType",
  "applyMode",
  "priority",
  "cooldownMinutes",
  "maxAffectedPerRun",
  "confirmDestructive",
  "locationId",
  "startAt",
  "endAt",
  "commandVersion",
  "filterAstVersion",
  "editOperationVersion",
  "scheduleVersion",
  "safetyConfirmation",
  "targetResolutionMode",
  "productIds",
  "variantIds",
  "targetIds",
]);

const BANNED_QUERY_FIELDS = new Set([
  "queryWhere",
  "where",
  "prismaWhere",
  "mongoQuery",
  "sql",
  "rawSql",
  "compiledFilter",
]);

export function normalizeCreateAutomaticProductRuleBody(body = {}) {
  const src = ensureObject(body, "INVALID_AUTOMATIC_RULE_CREATE_BODY");
  rejectUnknownFields(src, CREATE_KEYS, "AUTOMATIC_RULE_CREATE_UNSUPPORTED_FIELD");
  for (const key of BANNED_QUERY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      throw createValidationError(`Unsupported field: ${key}`, "UNSUPPORTED_FIELD");
    }
  }
  const targetResolutionMode = toStringOrNull(src.targetResolutionMode || "DYNAMIC_FILTER");
  if (!["DYNAMIC_FILTER", "STATIC_SAVED_SET"].includes(targetResolutionMode)) {
    throw createValidationError("Invalid targetResolutionMode", "INVALID_TARGET_MODE");
  }
  const hasDynamic = Boolean(src.filterAst) || (Array.isArray(src.conditions) && src.conditions.length > 0);
  const hasStaticIds = (Array.isArray(src.productIds) && src.productIds.length > 0)
    || (Array.isArray(src.variantIds) && src.variantIds.length > 0)
    || (Array.isArray(src.targetIds) && src.targetIds.length > 0);
  if (hasDynamic && hasStaticIds) {
    throw createValidationError("Ambiguous target mode", "AMBIGUOUS_TARGET_MODE");
  }
  const hasExplicitActions = (Array.isArray(src.rules) && src.rules.length > 0) || (Array.isArray(src.actions) && src.actions.length > 0);
  const hasEditedField = Boolean(src.editedField);
  if (hasExplicitActions && hasEditedField) {
    throw createValidationError("Ambiguous actions definition", "AMBIGUOUS_ACTION_DEFINITION");
  }
  const actions = Array.isArray(src.rules)
    ? src.rules
    : Array.isArray(src.actions)
      ? src.actions
      : src.editedField
        ? [{ field: src.editedField, locationId: src.locationId ?? null }]
        : undefined;

  const command = {
    title: toStringOrNull(src.title),
    description: toStringOrNull(src.description),
    filterAst: src.filterAst ?? null,
    conditions: Array.isArray(src.conditions) ? src.conditions : undefined,
    rawFilterInput: Array.isArray(src.rawFilterInput) ? src.rawFilterInput : undefined,
    actions,
    triggerType: toStringOrNull(src.triggerType || src.trigger),
    scheduleType: toStringOrNull(src.scheduleType || src.schedule?.type),
    scheduleConfig: src.scheduleConfig ?? src.schedule ?? null,
    cronExpression: toStringOrNull(src.cronExpression || src.schedule?.cronExpression),
    intervalMinutes: src.intervalMinutes ?? src.schedule?.intervalMinutes ?? null,
    timezone: toStringOrNull(src.timezone || src.schedule?.timezone),
    enabled: src.enabled,
    status: src.enabled === false ? "PAUSED" : src.status,
    targetResourceType: toStringOrNull(src.targetResourceType),
    applyMode: toStringOrNull(src.applyMode),
    priority: src.priority,
    cooldownMinutes: src.cooldownMinutes,
    maxAffectedPerRun: src.maxAffectedPerRun,
    confirmDestructive: src.confirmDestructive === true,
    safetyConfirmation: src.safetyConfirmation || null,
    targetResolutionMode,
    locationId: toStringOrNull(src.locationId),
    startAt: src.startAt ?? src.schedule?.startAt ?? null,
    endAt: src.endAt ?? src.schedule?.endAt ?? null,
  };
  return {
    commandVersion: Number(src.commandVersion || 1),
    filterAstVersion: Number(src.filterAstVersion || 1),
    editOperationVersion: Number(src.editOperationVersion || 1),
    scheduleVersion: Number(src.scheduleVersion || 1),
    command,
  };
}

const UPDATE_KEYS = new Set([
  "title",
  "description",
  "filterAst",
  "conditions",
  "rawFilterInput",
  "rules",
  "actions",
  "editedField",
  "trigger",
  "triggerType",
  "schedule",
  "scheduleType",
  "scheduleConfig",
  "cronExpression",
  "intervalMinutes",
  "timezone",
  "enabled",
  "status",
  "targetResourceType",
  "applyMode",
  "priority",
  "cooldownMinutes",
  "maxAffectedPerRun",
  "confirmDestructive",
  "locationId",
  "startAt",
  "endAt",
  "commandVersion",
  "filterAstVersion",
  "editOperationVersion",
  "scheduleVersion",
  "expectedRevision",
  "targetResolutionMode",
  "productIds",
  "variantIds",
  "targetIds",
  "id",
  "shop",
  "createdAt",
  "createdBy",
  "deletedAt",
  "lastAutomaticRuleRunId",
  "activeRunId",
  "executionIdentity",
]);

const IMMUTABLE_FIELDS = new Set([
  "id",
  "shop",
  "createdAt",
  "createdBy",
  "deletedAt",
  "lastAutomaticRuleRunId",
  "activeRunId",
  "executionIdentity",
]);

export function normalizeUpdateAutomaticProductRuleBody(body = {}) {
  const src = ensureObject(body, "INVALID_AUTOMATIC_RULE_UPDATE_BODY");
  rejectUnknownFields(src, UPDATE_KEYS, "AUTOMATIC_RULE_UPDATE_UNSUPPORTED_FIELD");
  for (const key of IMMUTABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      throw createValidationError(`Immutable field: ${key}`, "IMMUTABLE_FIELD");
    }
  }
  for (const key of BANNED_QUERY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      throw createValidationError(`Unsupported field: ${key}`, "UNSUPPORTED_FIELD");
    }
  }
  const { expectedRevision, ...patch } = src;
  const normalizedEnvelope = normalizeCreateAutomaticProductRuleBody(patch);
  const normalized = normalizedEnvelope.command;
  Object.keys(normalized).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(patch, key)
      && !["actions", "triggerType", "scheduleType", "scheduleConfig", "cronExpression", "intervalMinutes", "timezone", "enabled", "status"].includes(key)) {
      delete normalized[key];
    }
  });
  if (!Object.prototype.hasOwnProperty.call(patch, "rules") && !Object.prototype.hasOwnProperty.call(patch, "actions") && !Object.prototype.hasOwnProperty.call(patch, "editedField")) {
    delete normalized.actions;
  }
  if (!Object.prototype.hasOwnProperty.call(patch, "trigger") && !Object.prototype.hasOwnProperty.call(patch, "triggerType")) {
    delete normalized.triggerType;
  }
  if (!Object.prototype.hasOwnProperty.call(patch, "schedule") && !Object.prototype.hasOwnProperty.call(patch, "scheduleConfig")) {
    delete normalized.scheduleConfig;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "rules")) normalized.actions = patch.rules;
  if (Object.prototype.hasOwnProperty.call(patch, "trigger")) normalized.triggerType = patch.trigger;
  if (Object.prototype.hasOwnProperty.call(patch, "schedule")) normalized.scheduleConfig = patch.schedule;

  const parsedRevision = expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== ""
    ? Number(expectedRevision)
    : undefined;

  return {
    ...normalized,
    commandVersion: normalizedEnvelope.commandVersion,
    filterAstVersion: normalizedEnvelope.filterAstVersion,
    editOperationVersion: normalizedEnvelope.editOperationVersion,
    scheduleVersion: normalizedEnvelope.scheduleVersion,
    expectedRevision: parsedRevision,
  };
}

const LIST_QUERY_KEYS = new Set([
  "cursor",
  "limit",
  "status",
  "search",
  "sortKey",
  "sortDirection",
  "includeDeleted",
  "statuses",
]);
const LIST_STATUS = new Set(["ACTIVE", "PAUSED", "FAILED", "CANCELLED"]);
const LIST_SORT_KEYS = new Set(["createdAt", "updatedAt", "nextRunAt", "lastRunAt", "title", "status"]);

export function normalizeAutomaticRuleListQuery(query = {}) {
  rejectUnknownFields(query, LIST_QUERY_KEYS, "AUTOMATIC_RULE_LIST_UNSUPPORTED_QUERY");
  const status = toStringOrNull(query.status);
  if (status && !LIST_STATUS.has(status.toUpperCase())) {
    throw createValidationError("Unsupported status", "AUTOMATIC_RULE_LIST_STATUS_INVALID");
  }
  const page = normalizePagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    allowedSorts: ["createdAt", "updatedAt", "status", "nextRunAt"],
  });
  if (!LIST_SORT_KEYS.has(page.sortKey)) {
    throw createValidationError("Unsupported sortKey", "AUTOMATIC_RULE_LIST_SORT_KEY_INVALID");
  }
  return {
    cursor: page.cursor,
    limit: page.limit,
    status: status ? status.toUpperCase() : null,
    statuses: Array.isArray(query.statuses)
      ? query.statuses.map((s) => String(s).toUpperCase()).filter((s) => LIST_STATUS.has(s))
      : status
        ? [status.toUpperCase()]
        : ["ACTIVE", "PAUSED"],
    includeDeleted: String(query.includeDeleted || "false").toLowerCase() === "true",
    search: toStringOrNull(query.search),
    sortKey: page.sortKey,
    sortDirection: page.sortDirection,
  };
}

const RUNS_QUERY_KEYS = new Set([
  "cursor",
  "limit",
  "status",
  "startedAfter",
  "startedBefore",
]);
const RUN_STATUS = new Set(["PENDING", "PROCESSING", "SUCCESS", "FAILED", "SKIPPED"]);

export function normalizeAutomaticRuleRunsQuery(query = {}) {
  rejectUnknownFields(query, RUNS_QUERY_KEYS, "AUTOMATIC_RULE_RUNS_UNSUPPORTED_QUERY");
  const page = normalizePagination(query, {
    defaultLimit: 25,
    maxLimit: 100,
    allowedSorts: ["createdAt", "updatedAt", "status"],
  });
  const status = toStringOrNull(query.status);
  if (status && !RUN_STATUS.has(status.toUpperCase())) {
    throw createValidationError("Unsupported run status", "AUTOMATIC_RULE_RUN_STATUS_INVALID");
  }
  const startedAfter = toStringOrNull(query.startedAfter);
  const startedBefore = toStringOrNull(query.startedBefore);
  if (startedAfter && Number.isNaN(new Date(startedAfter).getTime())) {
    throw createValidationError("Invalid startedAfter", "AUTOMATIC_RULE_RUN_STARTED_AFTER_INVALID");
  }
  if (startedBefore && Number.isNaN(new Date(startedBefore).getTime())) {
    throw createValidationError("Invalid startedBefore", "AUTOMATIC_RULE_RUN_STARTED_BEFORE_INVALID");
  }
  return {
    cursor: page.cursor,
    limit: page.limit,
    sortKey: page.sortKey,
    sortDirection: page.sortDirection,
    status: status ? status.toUpperCase() : null,
    startedAfter,
    startedBefore,
  };
}

export function normalizeRuleIdParam(params = {}) {
  const id = toStringOrNull(params.id);
  if (!id) {
    throw createValidationError("id is required", "AUTOMATIC_RULE_ID_REQUIRED");
  }
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    throw createValidationError("Invalid rule id format", "AUTOMATIC_RULE_ID_INVALID");
  }
  return id;
}

export function validateRunAutomaticProductRuleNowCommand(input = {}) {
  const allowed = new Set(["automaticProductRuleId", "expectedRuleRevision", "idempotencyKey", "safetyConfirmation"]);
  for (const key of Object.keys(input || {})) {
    if (!allowed.has(key)) {
      const error = new Error(`Unsupported run-now field: ${key}`);
      error.code = "UNSUPPORTED_RUN_NOW_FIELD";
      error.statusCode = 400;
      throw error;
    }
  }

  if (
    typeof input.automaticProductRuleId !== "string"
    || input.automaticProductRuleId.trim().length < 8
  ) {
    const error = new Error("Invalid automatic product rule id.");
    error.code = "INVALID_AUTOMATIC_RULE_ID";
    error.statusCode = 400;
    throw error;
  }

  if (
    typeof input.idempotencyKey !== "string"
    || input.idempotencyKey.trim().length < 16
    || input.idempotencyKey.trim().length > 128
  ) {
    const error = new Error("Idempotency key is required.");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    error.statusCode = 400;
    throw error;
  }

  if (
    !Number.isInteger(input.expectedRuleRevision)
    || input.expectedRuleRevision < 1
  ) {
    const error = new Error("Expected rule revision is required.");
    error.code = "EXPECTED_RULE_REVISION_REQUIRED";
    error.statusCode = 400;
    throw error;
  }

  return {
    automaticProductRuleId: input.automaticProductRuleId.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
    expectedRuleRevision: input.expectedRuleRevision,
    safetyConfirmation: input.safetyConfirmation ?? null,
  };
}
