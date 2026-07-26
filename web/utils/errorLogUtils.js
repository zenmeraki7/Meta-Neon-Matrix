import { redactSensitive } from "./redactionUtils.js";

const MAX_SAFE_CONTEXT_BYTES = 8 * 1024;
const REPEAT_SAMPLE_WINDOW_MS = 30_000;
const recentErrorFingerprints = new Map();

async function getDbClient() {
  try {
    const { db } = await import("../repositories/repositoryDb.js");
    return db;
  } catch {
    return null;
  }
}

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
    const message = process.env.NODE_ENV === "production" ? null : err?.message;
    if (!shouldPersistError({ shop, type: "api", source, message })) return;

    const db = await getDbClient();
    if (!db || !db.errorLog || typeof db.errorLog.create !== "function") {
      return;
    }

    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        errorType: "api",
        level,
        message: boundedText(message || "API Error", 8000),
        stack: process.env.NODE_ENV === "production" ? null : boundedText(err?.stack, 32000),
        errorSource: source || null,
        requestId: req?.headers?.["x-request-id"] || req?.headers?.["x-correlation-id"] || null,
        method: req?.method || null,
        path: req?.originalUrl || req?.url || null,
        statusCode: err?.statusCode || 500,
        safeContext: safeJson({
          ...(metadata && typeof metadata === "object" ? metadata : {}),
          errorId,
          errorCode: err?.code || null,
          errorName: err?.name || null,
        }),
      },
    });
  } catch {
    // Logging failure must be caught silently
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
    const message = process.env.NODE_ENV === "production" ? null : err?.message;
    if (!shouldPersistError({ shop, type: "worker", source, message })) return;

    const db = await getDbClient();
    if (!db || !db.errorLog || typeof db.errorLog.create !== "function") return;

    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        errorType: "worker",
        level,
        message: boundedText(message || "Worker error", 8000),
        stack: process.env.NODE_ENV === "production" ? null : boundedText(err?.stack, 32000),
        errorSource: source || null,
        safeContext: safeJson(metadata),
      },
    });
  } catch {
    // Silent catch
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
    const message = process.env.NODE_ENV === "production" ? null : err?.message;
    if (!shouldPersistError({ shop, type: "webhook", source, message })) return;

    const db = await getDbClient();
    if (!db || !db.errorLog || typeof db.errorLog.create !== "function") return;

    await db.errorLog.create({
      data: {
        shop: shop || "unknown",
        errorType: "webhook",
        level,
        message: boundedText(message || "Webhook error", 8000),
        stack: process.env.NODE_ENV === "production" ? null : boundedText(err?.stack, 32000),
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
  } catch {
    // Silent catch
  }
};
