import {
  buildError,
  deepFreeze,
  toTrimmedString,
  validateIdempotencyKey,
} from "./normalizerPrimitives.js";

export function normalizeCommitBulkEditSessionCommand(params = {}, locals = {}, headers = {}) {
  const shopId = toTrimmedString(locals.shopify?.session?.shop);
  const sessionId = toTrimmedString(params.id);

  if (!shopId || !sessionId) {
    throw buildError("Session not found", 404, "SESSION_NOT_FOUND");
  }

  const idempotencyKey = validateIdempotencyKey(
    headers?.["idempotency-key"] || headers?.["Idempotency-Key"] || null,
    "idempotencyKey",
    { required: false },
  );

  return deepFreeze({ shopId, sessionId, idempotencyKey });
}
