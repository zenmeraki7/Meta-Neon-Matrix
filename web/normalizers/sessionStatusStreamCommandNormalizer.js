import {
  buildError,
  deepFreeze,
  toTrimmedString,
} from "./normalizerPrimitives.js";

export function normalizeSessionStatusStreamCommand(params = {}, locals = {}) {
  const shop = toTrimmedString(locals.shopify?.session?.shop);
  const sessionId = toTrimmedString(params.id);

  if (!shop) {
    throw buildError("Authentication required", 401, "UNAUTHENTICATED");
  }

  if (!sessionId) {
    throw buildError("Validation failed", 400, "VALIDATION_FAILED", [
      { field: "id", error: "session id is required" },
    ]);
  }

  return deepFreeze({ shop, sessionId });
}
