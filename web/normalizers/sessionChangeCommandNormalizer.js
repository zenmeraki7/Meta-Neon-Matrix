import {
  buildError,
  deepFreeze,
  toTrimmedString,
  validateIdempotencyKey,
} from "./normalizerPrimitives.js";

const NUMERIC_STRING = /^\d+$/;
const SAFE_CHANGE_FIELDS = new Set(["variantId", "namespace", "key", "value"]);

function normalizeRouteContext(params = {}, locals = {}) {
  const shopId = toTrimmedString(locals.shopify?.session?.shop);
  const sessionId = toTrimmedString(params.id);
  if (!shopId || !sessionId) {
    throw buildError("Session not found", 404, "SESSION_NOT_FOUND");
  }
  return { shopId, sessionId };
}

function assertSafePlainChangeItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "changes", error: "each change must be an object" },
    ]);
  }

  const keys = Object.keys(item);
  const unknown = keys.find((k) => !SAFE_CHANGE_FIELDS.has(k));
  if (unknown) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "changes", error: `unknown field ${unknown}` },
    ]);
  }

  for (const [k, v] of Object.entries(item)) {
    if (v != null && typeof v === "object") {
      throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
        { field: `changes.${k}`, error: "nested objects are not allowed" },
      ]);
    }
  }
}

function normalizeOneChange(item) {
  assertSafePlainChangeItem(item);

  const variantId = toTrimmedString(item.variantId);
  const namespace = toTrimmedString(item.namespace);
  const key = toTrimmedString(item.key);
  const value = item.value == null ? null : String(item.value);

  if (!variantId || !NUMERIC_STRING.test(variantId) || !namespace || !key) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "changes", error: "invalid change item shape" },
    ]);
  }

  if (namespace.length > 80 || key.length > 80 || value?.length > 5000) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "changes", error: "namespace/key/value too long" },
    ]);
  }

  return Object.freeze({ variantId, namespace, key, value });
}

export function normalizeStageSessionChangesCommand(params = {}, body = {}, locals = {}) {
  const context = normalizeRouteContext(params, locals);
  const changes = Array.isArray(body?.changes)
    ? body.changes
    : Array.isArray(body?.cells)
      ? body.cells
      : null;

  if (!changes || changes.length === 0 || changes.length > 1000) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "changes", error: "must be a non-empty array with max 1000 items" },
    ]);
  }

  const idempotencyKey = validateIdempotencyKey(
    body?.idempotencyKey || locals?.idempotencyKey || null,
    "idempotencyKey",
    { required: false },
  );

  return deepFreeze({
    shopId: context.shopId,
    sessionId: context.sessionId,
    changes: changes.map(normalizeOneChange),
    idempotencyKey,
  });
}

export function normalizeColumnApplySessionChangesCommand(params = {}, body = {}, locals = {}) {
  const context = normalizeRouteContext(params, locals);

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "body", error: "must be an object" },
    ]);
  }

  const namespace = toTrimmedString(body.namespace);
  const key = toTrimmedString(body.key);
  const value = body.value == null ? null : String(body.value);
  const variantIds = Array.isArray(body.variantIds) ? body.variantIds : [];

  if (!namespace || !key || variantIds.length === 0) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "namespace/key/variantIds", error: "namespace, key and non-empty variantIds are required" },
    ]);
  }

  if (namespace.length > 80 || key.length > 80 || value?.length > 5000) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "namespace/key/value", error: "value too long" },
    ]);
  }

  const normalizedVariantIds = variantIds.map((id) => toTrimmedString(id));
  if (normalizedVariantIds.some((id) => !NUMERIC_STRING.test(id))) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "variantIds", error: "all variantIds must be numeric strings" },
    ]);
  }

  const idempotencyKey = validateIdempotencyKey(
    body?.idempotencyKey || locals?.idempotencyKey || null,
    "idempotencyKey",
    { required: false },
  );

  return deepFreeze({
    shopId: context.shopId,
    sessionId: context.sessionId,
    namespace,
    key,
    value,
    variantIds: normalizedVariantIds,
    idempotencyKey,
  });
}
