import {
  buildError,
  deepFreeze,
  toTrimmedString,
  validateIdempotencyKey,
} from "./normalizerPrimitives.js";

export function normalizeSyncStartCommand(req = {}, session = null) {
  const shop = toTrimmedString(session?.shop);
  if (!shop) {
    throw buildError("Unauthenticated session", 401, "UNAUTHENTICATED");
  }

  const accessToken = toTrimmedString(session?.accessToken);
  if (!accessToken) {
    throw buildError("Session missing access token", 401, "UNAUTHENTICATED");
  }

  const forceRaw = String(req?.query?.force ?? req?.body?.force ?? "").trim().toLowerCase();
  const force = forceRaw === "true" || forceRaw === "1" || forceRaw === "yes";

  const idempotencyKey = validateIdempotencyKey(
    req?.headers?.["idempotency-key"] || req?.headers?.["Idempotency-Key"] || null,
    "idempotencyKey",
    { required: true },
  );

  return deepFreeze({
    shop,
    accessToken,
    force,
    idempotencyKey,
  });
}
