export const DEGRADATION_MESSAGES = Object.freeze({
  MIRROR_UNSAFE: Object.freeze({
    title: "Product data is refreshing",
    body: "Bulk editing is temporarily unavailable while we update your product data. This usually takes 5-10 minutes. No action needed.",
    showRetryAt: true,
    recoveryWindow: "5-10 minutes",
  }),
  SHOPIFY_UNAVAILABLE: Object.freeze({
    title: "Shopify is temporarily unavailable",
    body: "Your bulk edit has been paused and will resume automatically when Shopify is back online. No action needed.",
    showRetryAt: true,
    recoveryWindow: "automatically when Shopify is available",
  }),
  RATE_LIMIT_SUSPENDED: Object.freeze({
    title: "Processing slowed to protect your store",
    body: "Your bulk edit is processing at a reduced rate to stay within Shopify's limits. It will complete automatically. No action needed.",
    showRetryAt: false,
    recoveryWindow: "automatically as Shopify capacity restores",
  }),
  JOB_SUSPENDED: Object.freeze({
    title: "Bulk edit paused",
    body: "Your edit has been paused due to a temporary issue. It will resume automatically. No action needed.",
    showRetryAt: true,
    recoveryWindow: "within a few minutes",
  }),
});

function validIso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function buildDegradationContract(code, { retryAt = null } = {}) {
  const normalizedCode = String(code || "JOB_SUSPENDED").trim().toUpperCase();
  const message = DEGRADATION_MESSAGES[normalizedCode] || DEGRADATION_MESSAGES.JOB_SUSPENDED;
  return {
    code: DEGRADATION_MESSAGES[normalizedCode] ? normalizedCode : "JOB_SUSPENDED",
    ...message,
    retryAt: message.showRetryAt ? validIso(retryAt) : null,
  };
}

export function degradationFromError(error) {
  const raw = String(
    error?.degradationCode
    || error?.code
    || error?.details?.code
    || error?.message
    || "",
  ).toUpperCase();
  if (raw.includes("MIRROR_UNSAFE") || raw.includes("REPAIR_REQUIRED")) {
    return buildDegradationContract("MIRROR_UNSAFE", {
      retryAt: error?.retryAt || error?.details?.retryAt,
    });
  }
  if (
    raw.includes("SHOPIFY_UNAVAILABLE")
    || raw.includes("CIRCUIT_OPEN")
    || raw.includes("SERVICE_UNAVAILABLE")
  ) {
    return buildDegradationContract("SHOPIFY_UNAVAILABLE", {
      retryAt: error?.retryAfter || error?.retryAt || error?.details?.retryAt,
    });
  }
  if (raw.includes("THROTTL") || raw.includes("RATE_LIMIT") || Number(error?.status) === 429) {
    return buildDegradationContract("RATE_LIMIT_SUSPENDED");
  }
  return null;
}

export function degradationFromHistory(record) {
  const batch = record?.batch && typeof record.batch === "object" ? record.batch : {};
  const undo = record?.undo && typeof record.undo === "object" ? record.undo : {};
  const suspension = batch.suspension && typeof batch.suspension === "object"
    ? batch.suspension
    : undo;
  const rawState = String(record?.executionState || "").toUpperCase();
  const undoState = String(undo.state || "").toUpperCase();
  const reason = String(
    suspension.suspendReason
    || record?.failureStage
    || "",
  ).toUpperCase();

  if (reason.includes("MIRROR_UNSAFE") || reason.includes("REPAIR_REQUIRED")) {
    return buildDegradationContract("MIRROR_UNSAFE", {
      retryAt: suspension.resumeAfter,
    });
  }
  if (reason.includes("SHOPIFY_UNAVAILABLE")) {
    return buildDegradationContract("SHOPIFY_UNAVAILABLE", {
      retryAt: suspension.resumeAfter,
    });
  }
  if (reason.includes("THROTTL") || reason.includes("RATE_LIMIT")) {
    return buildDegradationContract("RATE_LIMIT_SUSPENDED");
  }
  if (rawState === "SUSPENDED" || undoState === "SUSPENDED") {
    return buildDegradationContract("JOB_SUSPENDED", {
      retryAt: suspension.resumeAfter,
    });
  }
  return null;
}
