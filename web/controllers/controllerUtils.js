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
  const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);

  await logApiError({
    shop: session?.shop,
    err: error,
    req,
    source,
    errorId: body?.errorId,
    metadata: {
      errorId: body?.errorId,
      route: req?.route?.path || null,
      method: req?.method || null,
      shopDomain: session?.shop || null,
      resolvedShopDomain: session?.id || session?.shop || null,
      controller: source,
      query: req?.query || {},
      bodySummary: summarizeRequestBody(req?.body),
      errorCode: error?.code || null,
      errorName: error?.name || null,
    },
  });

  return res.status(statusCode).json(body);
}

function summarizeRequestBody(body) {
  if (!body || typeof body !== "object") {
    return {
      present: Boolean(body),
      type: body === null ? "null" : typeof body,
    };
  }

  const filters = Array.isArray(body.filters) ? body.filters : null;
  const rawFilterInput = Array.isArray(body.rawFilterInput) ? body.rawFilterInput : null;

  return {
    present: true,
    keys: Object.keys(body).sort(),
    hasFilter: Object.prototype.hasOwnProperty.call(body, "filter"),
    filterType: body.filter == null ? null : typeof body.filter,
    filtersCount: filters ? filters.length : null,
    rawFilterInputCount: rawFilterInput ? rawFilterInput.length : null,
    hasCursor: Object.prototype.hasOwnProperty.call(body, "cursor"),
    hasLimit: Object.prototype.hasOwnProperty.call(body, "limit"),
  };
}
