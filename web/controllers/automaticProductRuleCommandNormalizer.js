function createValidationError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toTrimmedString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function hasControlChars(value) {
  return /[\x00-\x1F\x7F]/.test(String(value || ""));
}

function countAstConditions(node) {
  if (!node || typeof node !== "object") return 0;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countAstConditions(item), 0);
  const keys = Object.keys(node);
  let count = keys.includes("field") ? 1 : 0;
  for (const key of keys) {
    count += countAstConditions(node[key]);
  }
  return count;
}

function astDepth(node, depth = 0) {
  if (!node || typeof node !== "object") return depth;
  if (Array.isArray(node)) {
    return node.reduce((max, item) => Math.max(max, astDepth(item, depth + 1)), depth);
  }
  return Object.keys(node).reduce((max, key) => Math.max(max, astDepth(node[key], depth + 1)), depth);
}

function toNullableString(value) {
  const next = toTrimmedString(value);
  return next ? next : null;
}

function toPositiveIntOrNull(value, fallback = null, max = 250) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function validateAutomaticProductRuleId(id) {
  const normalizedId = toTrimmedString(id);
  if (!normalizedId) {
    throw createValidationError("automaticProductRuleId is required", "AUTOMATIC_RULE_ID_REQUIRED");
  }
  return normalizedId;
}

export function normalizeListPagination(query = {}) {
  return {
    cursorId: toNullableString(query.cursorId || query.cursor),
    limit: toPositiveIntOrNull(query.limit, 50, 100),
  };
}

export function normalizeCreateAutomaticProductRuleCommand(body = {}) {
  return {
    ...body,
    title: toNullableString(body.title),
    status: toNullableString(body.status),
    triggerType: toNullableString(body.triggerType),
    targetResourceType: toNullableString(body.targetResourceType),
    applyMode: toNullableString(body.applyMode),
  };
}

export function normalizeCreateAutomaticProductRuleBody(body = {}) {
  return normalizeCreateAutomaticProductRuleCommand(body);
}

function hasTargetDefinition(command = {}) {
  if (command.filterAst && typeof command.filterAst === "object") return true;
  if (Array.isArray(command.conditions) && command.conditions.length > 0) return true;
  if (Array.isArray(command.rawFilterInput) && command.rawFilterInput.length > 0) return true;
  return false;
}

export function validateCreateAutomaticProductRuleCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw createValidationError("command is required", "INVALID_AUTOMATIC_RULE_COMMAND");
  }
  const payload = command.command && typeof command.command === "object"
    ? command.command
    : command;

  const title = toTrimmedString(payload.title || payload.name);
  if (!title) {
    throw createValidationError("title is required", "AUTOMATIC_RULE_TITLE_REQUIRED");
  }
  if (title.length > 120 || hasControlChars(title)) {
    throw createValidationError("invalid rule name", "INVALID_RULE_NAME");
  }

  if (!hasTargetDefinition(payload)) {
    throw createValidationError(
      "filterAst or target definition is required",
      "AUTOMATIC_RULE_TARGET_REQUIRED",
    );
  }
  if (payload.filterAst && typeof payload.filterAst === "object") {
    const serialized = JSON.stringify(payload.filterAst);
    if (Buffer.byteLength(serialized, "utf8") > 50_000) {
      throw createValidationError("filter too large", "FILTER_TOO_COMPLEX");
    }
    if (astDepth(payload.filterAst) > 5) {
      throw createValidationError("filter too deep", "FILTER_TOO_COMPLEX");
    }
    if (countAstConditions(payload.filterAst) > 100) {
      throw createValidationError("too many conditions", "FILTER_TOO_COMPLEX");
    }
  }

  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const hasLegacyAction = toTrimmedString(payload.editedField).length > 0;
  if (actions.length > 0 && hasLegacyAction) {
    throw createValidationError("Ambiguous actions definition", "AMBIGUOUS_ACTION_DEFINITION");
  }
  if (actions.length === 0 && !hasLegacyAction) {
    throw createValidationError(
      "actions are required",
      "AUTOMATIC_RULE_ACTIONS_REQUIRED",
    );
  }

  const triggerType = toTrimmedString(payload.triggerType || "EVENT").toUpperCase();
  if (!["EVENT", "SCHEDULED", "HYBRID"].includes(triggerType)) {
    throw createValidationError("invalid triggerType", "AUTOMATIC_RULE_TRIGGER_INVALID");
  }
  if (triggerType !== "EVENT") {
    const hasScheduleConfig =
      Boolean(payload.scheduleType) ||
      Boolean(payload.cronExpression) ||
      Boolean(payload.intervalMinutes) ||
      Boolean(payload.scheduleConfig);
    if (!hasScheduleConfig) {
      throw createValidationError(
        "schedule config is required for scheduled rules",
        "AUTOMATIC_RULE_SCHEDULE_REQUIRED",
      );
    }
    const minIntervalMinutes = Number(payload.intervalMinutes ?? payload.scheduleConfig?.intervalMinutes ?? 0);
    if (minIntervalMinutes > 0 && minIntervalMinutes < 60) {
      throw createValidationError("recurrence too frequent", "RECURRENCE_TOO_FREQUENT");
    }
    const frequency = toTrimmedString(payload.scheduleConfig?.frequency || payload.scheduleType).toUpperCase();
    if (frequency && !["DAILY", "WEEKLY", "MONTHLY"].includes(frequency)) {
      throw createValidationError("invalid recurrence frequency", "RECURRENCE_TOO_FREQUENT");
    }
  }

  if (payload.scheduleConfig && typeof payload.scheduleConfig === "object") {
    const tz = payload.timezone || payload.scheduleConfig.timezone;
    if (!tz) {
      throw createValidationError("timezone is required for scheduled rules", "AUTOMATIC_RULE_TIMEZONE_REQUIRED");
    }
    if (payload.scheduleConfig.merchantLocalTime && !payload.scheduleConfig.startsAtUtc) {
      throw createValidationError(
        "startsAtUtc is required when merchantLocalTime is provided",
        "AUTOMATIC_RULE_SCHEDULE_UTC_REQUIRED",
      );
    }
  }

  if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") {
    throw createValidationError("enabled must be boolean", "AUTOMATIC_RULE_ENABLED_INVALID");
  }

  const normalizedActions = actions.length
    ? actions
    : [{ field: payload.editedField, locationId: payload.locationId }];
  const requiresLocation = normalizedActions.some((action) => {
    const field = toTrimmedString(action?.field).toLowerCase();
    return field === "inventory" || field === "inventoryquantity";
  });
  if (requiresLocation) {
    const hasLocation = normalizedActions.some((action) => toTrimmedString(action?.locationId));
    if (!hasLocation && !toTrimmedString(payload.locationId)) {
      throw createValidationError(
        "locationId is required for inventory rules",
        "AUTOMATIC_RULE_LOCATION_REQUIRED",
      );
    }
  }

  const isDestructive = normalizedActions.some((action) =>
    String(action?.field || "").toLowerCase() === "deleteproducts");
  if (isDestructive) {
    const confirmation = payload.safetyConfirmation || null;
    const expectedPhrase = "I understand this automatic rule can edit matching products";
    if (!confirmation?.confirmed || confirmation?.phrase !== expectedPhrase) {
      throw createValidationError(
        "safety confirmation is required for destructive rules",
        "AUTOMATIC_RULE_SAFETY_CONFIRMATION_REQUIRED",
      );
    }
  }

  return command;
}

export function normalizeUpdateAutomaticProductRuleCommand(body = {}) {
  return {
    ...body,
    title: body.title === undefined ? undefined : toNullableString(body.title),
    status: body.status === undefined ? undefined : toNullableString(body.status),
    triggerType: body.triggerType === undefined ? undefined : toNullableString(body.triggerType),
    targetResourceType: body.targetResourceType === undefined ? undefined : toNullableString(body.targetResourceType),
    applyMode: body.applyMode === undefined ? undefined : toNullableString(body.applyMode),
  };
}

export function validateUpdateAutomaticProductRuleCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw createValidationError("command is required", "INVALID_AUTOMATIC_RULE_COMMAND");
  }
  if (!command.expectedRevision) {
    throw createValidationError(
      "expectedRevision is required",
      "RULE_REVISION_REQUIRED",
    );
  }
  return command;
}
