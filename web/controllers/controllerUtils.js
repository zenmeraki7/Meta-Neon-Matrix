import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { buildActorContext } from "../utils/operationContextUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";

export function buildControllerError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function requireShopifySession(res) {
  const session = res.locals?.shopify?.session;
  if (!session?.shop) {
    throw buildControllerError("UNAUTHENTICATED", "Authentication required");
  }
  return session;
}

export function buildAuthenticatedActor(req, session) {
  return buildActorContext({
    req,
    session,
    fallbackType: "MERCHANT_ADMIN",
  });
}

export function getIdempotencyKey(req) {
  return req.get("Idempotency-Key") || null;
}

export function handleControllerError(res, error, fallbackCode) {
  const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);
  return res.status(statusCode).json(body);
}

export async function handleLoggedControllerError({
  res,
  req,
  session,
  error,
  source,
  fallbackCode,
}) {
  await logApiError({
    shop: session?.shop,
    err: error,
    req,
    source,
  });

  const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);

  return res.status(statusCode).json(body);
}
