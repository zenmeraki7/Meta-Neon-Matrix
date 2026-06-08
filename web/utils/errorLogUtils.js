// FILE: web/utils/errorLogUtils.js

import { db } from "../repositories/repositoryDb.js";
import { redactSensitive } from "./redactionUtils.js";

function sanitizeRequestForLogging(req = {}) {
  const headers = req?.headers && typeof req.headers === "object"
    ? { ...req.headers }
    : {};

  const payload = {
    method: req?.method,
    url: req?.originalUrl || req?.url || null,
    headers,
    query: req?.query,
    params: req?.params,
    body: req?.body ? summarizeRequestBody(req.body) : undefined,
    rawBody: req?.rawBody ? "[REDACTED]" : undefined,
    session: req?.session ? "[REDACTED]" : undefined,
    accessToken: req?.accessToken ? "[REDACTED]" : undefined,
  };

  return redactSensitive(payload);
}

function summarizeRequestBody(body) {
  if (!body || typeof body !== "object") {
    return {
      present: Boolean(body),
      type: body === null ? "null" : typeof body,
    };
  }

  return {
    present: true,
    keys: Object.keys(body).sort(),
    filterType: body.filter == null ? null : typeof body.filter,
    filtersCount: Array.isArray(body.filters) ? body.filters.length : null,
    filterParamsCount: Array.isArray(body.filterParams) ? body.filterParams.length : null,
    hasCursor: Object.prototype.hasOwnProperty.call(body, "cursor"),
    hasLimit: Object.prototype.hasOwnProperty.call(body, "limit"),
  };
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(redactSensitive(value ?? null)));
  } catch {
    return { note: "non_serializable_payload" };
  }
}

export const logApiError = async ({
  shop,
  err,
  req,
  source,
  level = "error",
  errorId = null,
  metadata = null,
}) => {
  try {
    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        type: "api",
        level,
        message: err?.message || "Unknown error",
        stack: err?.stack || null,
        source: source || null,
        requestId: req?.headers?.["x-request-id"] || req?.headers?.["x-correlation-id"] || null,
        method: req?.method || null,
        path: req?.originalUrl || req?.url || null,
        statusCode: err?.statusCode || 500,
        safeContext: safeJson({
          ...(metadata && typeof metadata === "object" ? metadata : {}),
          errorId,
          params: req?.params,
          query: req?.query,
          bodySummary: summarizeRequestBody(req?.body),
          hasSession: Boolean(req?.session),
          dbError: err?.meta || err?.clientVersion || err?.code || null,
          stack: err?.stack || null,
        }),
        request: safeJson({
          ...sanitizeRequestForLogging(req),
          errorId,
          statusCode: err?.statusCode || 500,
        }),
      },
    });
  } catch (e) {
    console.error("❌ API error log failed:", e?.message || e);
  }
};

export const logWorkerError = async ({
  err,
  shop,
  source,
  level = "error",
  metadata = null,
}) => {
  try {
    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        type: "worker",
        level,
        message: err?.message || "Unknown worker error",
        stack: err?.stack || null,
        source: source || null,
        safeContext: safeJson(metadata),
        request: safeJson(metadata),
      },
    });
  } catch (e) {
    console.error("❌ Worker error log failed:", e?.message || e);
  }
};

export const logWebhookError = async ({
  err,
  req,
  source,
  shop,
  level = "error",
}) => {
  try {
    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        type: "webhook",
        level,
        message: err?.message || "Unknown webhook error",
        stack: err?.stack || null,
        source: source || null,
        requestId: req?.headers?.["x-request-id"] || req?.headers?.["x-shopify-webhook-id"] || null,
        method: req?.method || null,
        path: req?.originalUrl || req?.url || null,
        statusCode: err?.statusCode || 500,
        safeContext: safeJson({
          webhookTopic: req?.headers?.["x-shopify-topic"] || null,
          shopDomain: req?.headers?.["x-shopify-shop-domain"] || shop || null,
        }),
        request: safeJson({
          ...sanitizeRequestForLogging(req),
          statusCode: err?.statusCode || 500,
        }),
      },
    });
  } catch (e) {
    console.error("❌ Webhook error log failed:", e?.message || e);
  }
};
