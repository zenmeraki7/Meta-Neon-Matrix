// FILE: web/utils/errorLogUtils.js

import { db } from "../repositories/repositoryDb.js";
import { redactSensitive } from "./redactionUtils.js";

const MAX_SAFE_CONTEXT_BYTES = 8 * 1024;
const REPEAT_SAMPLE_WINDOW_MS = 30_000;
const recentErrorFingerprints = new Map();

function boundedText(value, maxLength) {
  if (value == null) return null;
  const text = String(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 14)}…[truncated]`;
}

function shouldPersistError({ shop, type, source, message }) {
  const now = Date.now();
  const key = `${shop || "unknown"}:${type}:${source || "unknown"}:${message || "unknown"}`;
  const last = recentErrorFingerprints.get(key) || 0;
  recentErrorFingerprints.set(key, now);
  if (recentErrorFingerprints.size > 2_000) {
    for (const [candidate, timestamp] of recentErrorFingerprints) {
      if (now - timestamp > REPEAT_SAMPLE_WINDOW_MS) recentErrorFingerprints.delete(candidate);
    }
  }
  return now - last >= REPEAT_SAMPLE_WINDOW_MS;
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
    rawFilterInputCount: Array.isArray(body.rawFilterInput) ? body.rawFilterInput.length : null,
    hasCursor: Object.prototype.hasOwnProperty.call(body, "cursor"),
    hasLimit: Object.prototype.hasOwnProperty.call(body, "limit"),
  };
}

function safeJson(value) {
  try {
    const serialized = JSON.stringify(redactSensitive(value ?? null));
    if (Buffer.byteLength(serialized, "utf8") > MAX_SAFE_CONTEXT_BYTES) {
      return {
        truncated: true,
        originalBytes: Buffer.byteLength(serialized, "utf8"),
      };
    }
    return JSON.parse(serialized);
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
    if (!shouldPersistError({ shop, type: "api", source, message: err?.message })) return;
    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        errorType: "api",
        level,
        message: boundedText(err?.message || "Unknown error", 8000),
        stack: boundedText(err?.stack, 32000),
        errorSource: source || null,
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
    if (!shouldPersistError({ shop, type: "worker", source, message: err?.message })) return;
    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        errorType: "worker",
        level,
        message: boundedText(err?.message || "Unknown worker error", 8000),
        stack: boundedText(err?.stack, 32000),
        errorSource: source || null,
        safeContext: safeJson(metadata),
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
    if (!shouldPersistError({ shop, type: "webhook", source, message: err?.message })) return;
    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        errorType: "webhook",
        level,
        message: boundedText(err?.message || "Unknown webhook error", 8000),
        stack: boundedText(err?.stack, 32000),
        errorSource: source || null,
        requestId: req?.headers?.["x-request-id"] || req?.headers?.["x-shopify-webhook-id"] || null,
        method: req?.method || null,
        path: req?.originalUrl || req?.url || null,
        statusCode: err?.statusCode || 500,
        safeContext: safeJson({
          webhookTopic: req?.headers?.["x-shopify-topic"] || null,
          shopDomain: req?.headers?.["x-shopify-shop-domain"] || shop || null,
        }),
      },
    });
  } catch (e) {
    console.error("❌ Webhook error log failed:", e?.message || e);
  }
};
