const MAX_ID_LENGTH = 255;
const MAX_SHOP_LENGTH = 255;
const MAX_ACTOR_TYPE_LENGTH = 100;
const MAX_EMAIL_LENGTH = 320;
const MAX_NAME_LENGTH = 255;
const MAX_PLAN_LENGTH = 100;
const MAX_STATUS_LENGTH = 100;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function buildCommandError(code, message = code) {
  const error = new Error(message);
  error.code = code;
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

function normalizeString(value, fallback = null, maxLength = MAX_ID_LENGTH) {
  if (value === undefined || value === null) return fallback;

  const stringValue = String(value).trim();

  if (!stringValue) return fallback;

  return stringValue.length > maxLength
    ? stringValue.slice(0, maxLength)
    : stringValue;
}

function normalizeNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requireShop(shop) {
  const normalizedShop = normalizeString(shop, null, MAX_SHOP_LENGTH);

  if (!normalizedShop) {
    throw buildCommandError("SHOP_REQUIRED", "Authenticated shop is required");
  }

  return normalizedShop;
}

function requireActor(actor) {
  if (!isPlainObject(actor)) {
    throw buildCommandError("ACTOR_REQUIRED", "Actor context is required");
  }

  const normalizedActor = {
    type: normalizeString(actor.type, null, MAX_ACTOR_TYPE_LENGTH),
    userId: normalizeString(actor.userId, null, MAX_ID_LENGTH),
    email: normalizeString(actor.email, null, MAX_EMAIL_LENGTH),
    name: normalizeString(actor.name, null, MAX_NAME_LENGTH),
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
    plan: normalizeString(subscription.plan, null, MAX_PLAN_LENGTH),
    status: normalizeString(subscription.status, null, MAX_STATUS_LENGTH),
    cappedAmount: normalizeNumber(subscription.cappedAmount),
    trialEndsAt: normalizeDate(subscription.trialEndsAt),
  });
}

function requireIdempotencyKey(idempotencyKey) {
  const normalizedKey = normalizeString(
    idempotencyKey,
    null,
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );

  if (!normalizedKey) {
    throw buildCommandError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required for clear product types",
    );
  }

  return normalizedKey;
}

export function buildClearProductTypesCommand({
  shop,
  actor,
  idempotencyKey,
  subscription = null,
}) {
  return deepFreeze({
    shop: requireShop(shop),
    actor: requireActor(actor),
    idempotencyKey: requireIdempotencyKey(idempotencyKey),
    subscription: normalizeSubscription(subscription),
    commandType: "CLEAR_PRODUCT_TYPES",
    requestedAt: new Date().toISOString(),
  });
}

export default {
  buildClearProductTypesCommand,
};
