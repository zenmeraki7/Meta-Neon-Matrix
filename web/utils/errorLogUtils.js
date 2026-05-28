// FILE: web/utils/errorLogUtils.js

import { prisma } from "../config/database.js";
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
    body: req?.body ? "[REDACTED]" : undefined,
    rawBody: req?.rawBody ? "[REDACTED]" : undefined,
    session: req?.session ? "[REDACTED]" : undefined,
    accessToken: req?.accessToken ? "[REDACTED]" : undefined,
  };

  return redactSensitive(payload);
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
}) => {
  try {
    await prisma.errorLog.create({
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
          params: req?.params,
          query: req?.query,
          hasBody: Boolean(req?.body && Object.keys(req.body).length > 0),
          hasSession: Boolean(req?.session),
        }),
        request: safeJson({
          ...sanitizeRequestForLogging(req),
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
    await prisma.errorLog.create({
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
    await prisma.errorLog.create({
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
