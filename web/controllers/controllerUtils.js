import { buildActorContext } from "../utils/operationContextUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { normalizeShopDomain } from "../utils/shopDomainUtils.js";

export { normalizeShopDomain };

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MAX_LOGGED_KEYS = 50;
const MAX_LOGGED_VALUE_LENGTH = 100;
const MAX_REPORTED_COLLECTION_LENGTH = 1_000_000;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:/+-]+$/;

import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function buildDefaultPublicApiErrorResponse(error, fallbackCode) {
  try {
    const res = buildPublicApiErrorResponse(error, fallbackCode);
    if (res?.body && !res.body.error) {
      res.body.error = {
        code: res.body.code || fallbackCode || "INTERNAL_ERROR",
        message: res.body.message || "An error occurred while processing the request",
      };
    }
    return res;
  } catch {
    return {
      statusCode: 500,
      body: {
        ok: false,
        success: false,
        code: fallbackCode || "INTERNAL_ERROR",
        message: "An error occurred while processing the request",
        error: {
          code: fallbackCode || "INTERNAL_ERROR",
          message: "An error occurred while processing the request",
        },
        errorId: `err_${Date.now().toString(36)}`,
      },
    };
  }
}

/**
 * Builds an application error that can be safely mapped by API error handlers.
 */
export function buildControllerError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Returns the original verified Shopify session and its canonical tenant key.
 * Supports both requireShopifySession(res) and requireShopifySession(req, res).
 */
export function requireShopifySession(reqOrRes, res) {
  const actualRes = res || reqOrRes;
  const session = actualRes?.locals?.shopify?.session;
  const shop = normalizeShopDomain(session?.shop);

  if (!session || !shop) {
    throw buildControllerError("UNAUTHENTICATED", "Authentication required");
  }

  return Object.freeze({
    session,
    shop,
  });
}

/**
 * Builds an actor context using a verified Shopify session and canonical shop.
 */
export function buildAuthenticatedActor(req, session, shop) {
  const canonicalShop = shop || normalizeShopDomain(session?.shop);

  if (!session || typeof session !== "object" || !canonicalShop) {
    throw buildControllerError("UNAUTHENTICATED", "Authentication required");
  }

  return buildActorContext({
    req,
    session,
    shop: canonicalShop,
    fallbackType: "MERCHANT_ADMIN",
  });
}

/**
 * Reads and validates the required command idempotency key.
 * Enforces key pattern, length limit, and duplicate header checks.
 */
export function getRequiredIdempotencyKey(req) {
  if (!req || typeof req.get !== "function") {
    throw buildControllerError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required",
    );
  }

  const rawHeaders = req.headers?.["idempotency-key"];
  if (Array.isArray(rawHeaders) && rawHeaders.length > 1) {
    throw buildControllerError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key header is invalid",
    );
  }

  const rawValue = req.get("Idempotency-Key");

  if (rawValue === null || rawValue === undefined) {
    throw buildControllerError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required",
    );
  }

  if (typeof rawValue !== "string" || rawValue.includes(",")) {
    throw buildControllerError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key header is invalid",
    );
  }

  const value = rawValue.trim();

  if (!value) {
    throw buildControllerError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "Idempotency-Key header is required",
    );
  }

  if (
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw buildControllerError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key header is invalid",
    );
  }

  return value;
}

export function capReportedLength(value) {
  const num = Number(value);
  const safeInt = Number.isSafeInteger(num) ? Math.max(0, num) : 0;
  return Math.min(safeInt, MAX_REPORTED_COLLECTION_LENGTH);
}

export function normalizeHttpStatus(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}

export function normalizePublicErrorBody(body, fallbackCode) {
  if (isPlainObject(body)) {
    return body;
  }

  return {
    error: {
      code: fallbackCode || "INTERNAL_ERROR",
      message: "The request could not be completed",
    },
  };
}

export function summarizeError(error) {
  return {
    name: normalizeLoggedValue(error?.name),
    code: normalizeLoggedValue(error?.code),
    message:
      process.env.NODE_ENV === "production"
        ? null
        : normalizeLoggedValue(error?.message, 500),
    stack:
      process.env.NODE_ENV === "production"
        ? null
        : normalizeLoggedValue(error?.stack, 2000),
  };
}

export function safeSummarize(summaryFn, value) {
  try {
    return summaryFn(value);
  } catch {
    return {
      present: value !== null && value !== undefined,
      type: "unavailable",
    };
  }
}

/**
 * Maps internal errors to a safe public API response, sending the response
 * structurally BEFORE initiating non-blocking background logging.
 */
export function handleControllerError(
  req,
  res,
  error,
  fallbackCode,
  source = fallbackCode,
) {
  const { statusCode, body } = buildDefaultPublicApiErrorResponse(error, fallbackCode);

  const shop = normalizeShopDomain(res?.locals?.shopify?.session?.shop);
  const requestId = normalizeLoggedValue(
    res?.locals?.requestId,
    MAX_LOGGED_VALUE_LENGTH,
  );

  if (res?.headersSent) {
    safelyLogControllerError({
      req,
      shop,
      requestId,
      error,
      fallbackCode,
      source,
      errorId: body?.errorId,
    });
    return undefined;
  }

  const safeStatusCode = normalizeHttpStatus(statusCode);
  const safeBody = normalizePublicErrorBody(body, fallbackCode);

  const response = res.status(safeStatusCode).json(safeBody);

  safelyLogControllerError({
    req,
    shop,
    requestId,
    error,
    fallbackCode,
    source,
    errorId: safeBody?.errorId,
  });

  return response;
}

function safelyLogControllerError({
  req,
  shop,
  requestId,
  error,
  fallbackCode,
  source,
  errorId,
}) {
  const safeFallbackCode =
    normalizeLoggedValue(fallbackCode) || "CONTROLLER_ERROR";
  const safeSource = normalizeLoggedValue(source) || safeFallbackCode;
  const safeErrorId = normalizeLoggedValue(errorId);

  Promise.resolve()
    .then(() => {
      const requestContext = buildSafeRequestContext({
        req,
        requestId,
      });

      return logApiError({
        shop,
        err: summarizeError(error),
        source: safeSource,
        errorId: safeErrorId,
        metadata: {
          ...requestContext,
          source: safeSource,
          fallbackCode: safeFallbackCode,
          errorId: safeErrorId,
          errorCode: normalizeLoggedValue(error?.code),
          errorName: normalizeLoggedValue(error?.name),
        },
      });
    })
    .catch(() => {
      // Logging failure must never alter or disrupt the HTTP API response.
    });
}

function buildSafeRequestContext({ req, requestId }) {
  return {
    method: normalizeLoggedValue(req?.method, 16),
    route: normalizeRoutePath(req?.route?.path),
    requestId,
    querySummary: safeSummarize(summarizeRequestQuery, req?.query),
    bodySummary: safeSummarize(summarizeRequestBody, req?.body),
  };
}

function normalizeRoutePath(value) {
  if (typeof value === "string") {
    return normalizeLoggedValue(value, MAX_LOGGED_VALUE_LENGTH);
  }

  if (Array.isArray(value)) {
    const routes = value
      .filter((item) => typeof item === "string")
      .slice(0, 10)
      .join(",");

    return normalizeLoggedValue(routes, MAX_LOGGED_VALUE_LENGTH);
  }

  return null;
}

function normalizeLoggedValue(value, maxLength = MAX_LOGGED_VALUE_LENGTH) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();

  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function summarizeRequestQuery(query) {
  if (!isPlainObject(query)) {
    return summarizeNonPlainObject(query);
  }

  return summarizeObjectKeys(query);
}

function summarizeRequestBody(body) {
  if (Array.isArray(body)) {
    const len = capReportedLength(body.length);
    return {
      present: true,
      type: "array",
      length: len,
      lengthCapped: body.length > MAX_REPORTED_COLLECTION_LENGTH,
    };
  }

  if (!isPlainObject(body)) {
    return summarizeNonPlainObject(body);
  }

  return summarizeObjectKeys(body);
}

function summarizeObjectKeys(value) {
  let keys = [];
  try {
    keys = Object.keys(value).sort();
  } catch {
    return {
      present: true,
      type: "unavailable",
    };
  }

  const cappedKeyCount = capReportedLength(keys.length);
  const loggedKeys = keys
    .slice(0, MAX_LOGGED_KEYS)
    .map((key) => normalizeLoggedValue(key, MAX_LOGGED_VALUE_LENGTH))
    .filter(Boolean);

  return {
    present: true,
    type: "object",
    keyCount: cappedKeyCount,
    keyCountCapped: keys.length > MAX_REPORTED_COLLECTION_LENGTH,
    keys: loggedKeys,
    truncated: keys.length > MAX_LOGGED_KEYS,
  };
}

function summarizeNonPlainObject(value) {
  if (value === null) {
    return { present: false, type: "null" };
  }

  if (value === undefined) {
    return { present: false, type: "undefined" };
  }

  if (Buffer.isBuffer(value)) {
    const len = capReportedLength(value.length);
    return {
      present: true,
      type: "buffer",
      length: len,
      lengthCapped: value.length > MAX_REPORTED_COLLECTION_LENGTH,
    };
  }

  if (Array.isArray(value)) {
    const len = capReportedLength(value.length);
    return {
      present: true,
      type: "array",
      length: len,
      lengthCapped: value.length > MAX_REPORTED_COLLECTION_LENGTH,
    };
  }

  if (typeof value === "object") {
    return {
      present: true,
      type: "non_plain_object",
    };
  }

  return {
    present: true,
    type: normalizeLoggedValue(typeof value, 50) || "unknown",
  };
}