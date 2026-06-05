import {
  buildError,
  deepFreeze,
  toTrimmedString,
} from "./normalizerPrimitives.js";

const SCHEDULED_EXPORT_ID_MAX_LENGTH = 200;
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
  return scheduledExportId;
}

function normalizeSubscription(locals = {}) {
  const entitlement = locals.entitlement;
  if (!entitlement || typeof entitlement !== "object") return null;

  return {
    shop: toTrimmedString(entitlement.shop) || null,
    planKey: toTrimmedString(entitlement.planKey) || "FREE",
    planName: toTrimmedString(entitlement.planName) || "Free Plan",
    limit: entitlement.limit,
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
  return deepFreeze({
    shop: normalizeShop(locals),
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
