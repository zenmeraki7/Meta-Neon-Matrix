import {
  buildError,
  deepFreeze,
  isPlainObject,
  normalizeIntInRange,
  toTrimmedString,
} from "./normalizerPrimitives.js";

const SCHEDULED_EXPORT_ID_MAX_LENGTH = 200;
const SCHEDULED_EXPORT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SCHEDULED_EXPORT_CURSOR_MAX_LENGTH = 200;
const VALID_STATUSES = new Set([
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "INACTIVE",
]);

const PAYLOAD_KEYS = Object.freeze([
  "fields",
  "filename",
  "fileName",
  "filterParams",
  "filterAst",
  "status",
  "scheduleType",
  "timezone",
  "scheduleConfig",
  "cronExpression",
  "intervalMinutes",
  "title",
  "startAt",
  "endAt",
  "targetGranularity",
]);

function clonePayloadValue(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (Array.isArray(value)) {
    return value.map((item, index) => clonePayloadValue(item, `${fieldName}[${index}]`));
  }

  if (typeof value === "object") {
    if (!isPlainObject(value)) {
      throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
        { field: fieldName, error: "must be a plain object" },
      ]);
    }

    const cloned = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
          { field: fieldName, error: "contains an unsafe key" },
        ]);
      }
      cloned[key] = clonePayloadValue(child, `${fieldName}.${key}`);
    }
    return cloned;
  }

  return value;
}

function normalizeShop(locals = {}) {
  const shop = toTrimmedString(locals.shopify?.session?.shop);
  if (!shop) {
    throw buildError("Authentication required", 401, "UNAUTHENTICATED");
  }
  return shop;
}

function normalizeScheduledExportId(params = {}) {
  const scheduledExportId = toTrimmedString(params.id);
  if (!scheduledExportId || scheduledExportId.length > SCHEDULED_EXPORT_ID_MAX_LENGTH) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "id", error: "scheduled export id is required" },
    ]);
  }
  if (!SCHEDULED_EXPORT_ID_PATTERN.test(scheduledExportId)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "id", error: "invalid format" },
    ]);
  }
  return scheduledExportId;
}

function normalizeCursorId(params = {}) {
  const cursorId = toTrimmedString(params.cursorId ?? params.cursor);
  if (!cursorId) return null;
  if (
    cursorId.length > SCHEDULED_EXPORT_CURSOR_MAX_LENGTH ||
    !SCHEDULED_EXPORT_ID_PATTERN.test(cursorId)
  ) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "cursorId", error: "invalid format" },
    ]);
  }
  return cursorId;
}

function normalizeEntitlementLimit(value) {
  if (value === undefined || value === null || value === "") return null;
  const limit = Number(value);
  return Number.isFinite(limit) && limit >= 0 ? limit : null;
}

function normalizeSubscription(locals = {}) {
  const entitlement = locals.entitlement;
  if (!entitlement || typeof entitlement !== "object") return null;

  return {
    shop: toTrimmedString(entitlement.shop) || null,
    planKey: toTrimmedString(entitlement.planKey) || "FREE",
    planName: toTrimmedString(entitlement.planName) || "Free Plan",
    limit: normalizeEntitlementLimit(entitlement.limit),
    isUnlimited: Boolean(entitlement.isUnlimited),
    status: toTrimmedString(entitlement.status) || "FREE",
    subscriptionId: entitlement.subscriptionId || null,
    isCreditUser: entitlement.isCreditUser === true,
  };
}

function normalizeBodyPayload(body = {}, { requireFields = false } = {}) {
  if (!isPlainObject(body)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "body", error: "must be an object" },
    ]);
  }

  if (requireFields && (!Array.isArray(body.fields) || body.fields.length === 0)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "fields", error: "must be a non-empty array" },
    ]);
  }

  if (body.status !== undefined) {
    const status = toTrimmedString(body.status).toUpperCase();
    if (!VALID_STATUSES.has(status)) {
      throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
        { field: "status", error: "is unsupported" },
      ]);
    }
  }

  const payload = {};
  for (const key of PAYLOAD_KEYS) {
    if (body[key] !== undefined) {
      payload[key] = clonePayloadValue(body[key], key);
    }
  }

  return payload;
}

function baseCommand(locals = {}) {
  return {
    shop: normalizeShop(locals),
    subscription: normalizeSubscription(locals),
  };
}

export function normalizeCreateScheduledExportCommand(params = {}, body = {}, locals = {}) {
  return deepFreeze({
    ...baseCommand(locals),
    scheduledExport: normalizeBodyPayload(body, { requireFields: true }),
  });
}

export function normalizeListScheduledExportsCommand(params = {}, body = {}, locals = {}) {
  void body;
  const safeQuery = isPlainObject(params) ? params : {};
  return deepFreeze({
    shop: normalizeShop(locals),
    limit: normalizeIntInRange(safeQuery.limit, {
      fallback: 100,
      min: 1,
      max: 250,
      fieldName: "limit",
    }),
    cursorId: normalizeCursorId(safeQuery),
  });
}

export function normalizeGetScheduledExportCommand(params = {}, body = {}, locals = {}) {
  return deepFreeze({
    shop: normalizeShop(locals),
    scheduledExportId: normalizeScheduledExportId(params),
  });
}

export function normalizeUpdateScheduledExportCommand(params = {}, body = {}, locals = {}) {
  return deepFreeze({
    ...baseCommand(locals),
    scheduledExportId: normalizeScheduledExportId(params),
    scheduledExport: normalizeBodyPayload(body),
  });
}

export function normalizeToggleScheduledExportStatusCommand(params = {}, body = {}, locals = {}) {
  const payload = normalizeBodyPayload(body);
  return deepFreeze({
    ...baseCommand(locals),
    scheduledExportId: normalizeScheduledExportId(params),
    status: payload.status,
  });
}

export function normalizeDeleteScheduledExportCommand(params = {}, body = {}, locals = {}) {
  return deepFreeze({
    shop: normalizeShop(locals),
    scheduledExportId: normalizeScheduledExportId(params),
  });
}
