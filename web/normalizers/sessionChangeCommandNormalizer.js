import {
  buildError,
  deepFreeze,
  isPlainObject,
  toTrimmedString,
  validateIdempotencyKey,
} from "./normalizerPrimitives.js";

const NUMERIC_STRING = /^\d+$/;
const METAFIELD_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SESSION_ID_LENGTH = 200;
const MAX_CHANGE_ITEMS = 1000;
const SAFE_CHANGE_FIELDS = new Set(["variantId", "namespace", "key", "value"]);

function normalizeRouteContext(params = {}, locals = {}) {
  const shopId = toTrimmedString(locals.shopify?.session?.shop);
  const sessionId = toTrimmedString(params.id);
  if (!shopId) {
    throw buildError("Authentication required", 401, "UNAUTHENTICATED");
  }
  if (!sessionId) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "id", error: "is required" },
    ]);
  }
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "id", error: "invalid format" },
    ]);
  }
  return { shopId, sessionId };
}

function assertSafePlainChangeItem(item) {
  if (!isPlainObject(item)) {
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
    // Rejects objects and arrays; arrays also report typeof value === "object".
    if (v != null && typeof v === "object") {
      throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
        { field: `changes.${k}`, error: "nested objects are not allowed" },
      ]);
    }
  }
}

function assertValidMetafieldIdentifier(value, fieldName) {
  if (!value || value.length > 80) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: fieldName, error: "must be 1-80 characters" },
    ]);
  }
  if (!METAFIELD_KEY_PATTERN.test(value)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: fieldName, error: "invalid format" },
    ]);
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

  assertValidMetafieldIdentifier(namespace, "changes.namespace");
  assertValidMetafieldIdentifier(key, "changes.key");

  if (value?.length > 5000) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "changes.value", error: "must be 5000 characters or fewer" },
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

  if (!isPlainObject(body)) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "body", error: "must be an object" },
    ]);
  }

  const namespace = toTrimmedString(body.namespace);
  const key = toTrimmedString(body.key);
  const value = body.value == null ? null : String(body.value);
  const variantIds = Array.isArray(body.variantIds) ? body.variantIds : [];

  if (!namespace || !key || variantIds.length === 0 || variantIds.length > MAX_CHANGE_ITEMS) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "variantIds", error: "must be a non-empty array with max 1000 items" },
    ]);
  }

  assertValidMetafieldIdentifier(namespace, "namespace");
  assertValidMetafieldIdentifier(key, "key");

  if (value?.length > 5000) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "value", error: "must be 5000 characters or fewer" },
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
