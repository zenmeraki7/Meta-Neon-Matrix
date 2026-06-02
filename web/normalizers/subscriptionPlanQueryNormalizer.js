import {
  buildError,
  deepFreeze,
  toTrimmedString,
  validateNoUnsafeNestedObjects,
} from "./normalizerPrimitives.js";

export function normalizeSubscriptionPlanQuery(locals = {}, query = {}) {
  const shop = toTrimmedString(locals?.shopify?.session?.shop);
  if (!shop) {
    throw buildError("Unauthenticated session", 401, "UNAUTHENTICATED");
  }

  validateNoUnsafeNestedObjects(query || {}, "query", {
    allowedObjectPaths: new Set(),
  });

  return deepFreeze({ shop });
}
