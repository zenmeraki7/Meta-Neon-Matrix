import logger from "../utils/loggerUtils.js";

const ALLOWED_METRICS = new Set(["CLS", "INP", "LCP", "TTFB", "FCP"]);
const ALLOWED_EVENT_TYPES = new Set([
  "web_vital",
  "route_timing",
  "api_timing",
  "interaction_timing",
  "render_timing",
  "polling_timing",
]);
const ALLOWED_RATINGS = new Set(["good", "needs-improvement", "poor", "unknown"]);

function normalizeMetricName(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeString(value, max = 64, fallback = "unknown") {
  const normalized = String(value || "").trim();
  if (!normalized) return fallback;
  return normalized.slice(0, max);
}

function normalizeBoolean(value, fallback = true) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

export async function ingestWebVitals(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const metricName = normalizeMetricName(body.name);
  const value = normalizeFiniteNumber(body.value);
  const rating = String(body.rating || "").trim().toLowerCase() || "unknown";
  const pagePath = String(body.pagePath || "").trim().slice(0, 256);
  const metricId = String(body.id || "").trim().slice(0, 128);
  const navigationType = String(body.navigationType || "").trim().slice(0, 64);
  const locale = String(body.locale || "").trim().slice(0, 32);
  const appVersion = String(body.appVersion || "").trim().slice(0, 64);
  const userAgent = req.get("user-agent") || "unknown";

  if (!ALLOWED_METRICS.has(metricName) || value == null) {
    return res.status(400).json({
      success: false,
      code: "INVALID_WEB_VITAL_PAYLOAD",
      message: "Invalid web vital payload.",
    });
  }

  logger.info("web_vital_captured", {
    metricName,
    value,
    rating,
    metricId,
    navigationType,
    pagePath,
    locale,
    appVersion,
    userAgent,
  });

  return res.status(202).json({ success: true });
}

export async function ingestFrontendPerformanceEvent(req, res) {
  const body = req.body && typeof req.body === "object" ? req.body : {};

  // Strict DTO: only scalar fields are accepted.
  const payload = {
    eventType: normalizeString(body.eventType, 64),
    metricName: normalizeString(body.metricName, 64),
    valueMs: normalizeFiniteNumber(body.valueMs),
    valueUnit: normalizeString(body.valueUnit, 16, "ms"),
    rating: normalizeString(body.rating, 32).toLowerCase(),
    routeGroup: normalizeString(body.routeGroup, 64),
    routePattern: normalizeString(body.routePattern, 256, "/"),
    productCountBucket: normalizeString(body.productCountBucket, 32),
    variantCountBucket: normalizeString(body.variantCountBucket, 32),
    filterCountBucket: normalizeString(body.filterCountBucket, 32),
    rowCountBucket: normalizeString(body.rowCountBucket, 32),
    payloadSizeBucket: normalizeString(body.payloadSizeBucket, 32),
    success: normalizeBoolean(body.success, true),
    status: normalizeString(body.status, 64),
    sampleRate: normalizeFiniteNumber(body.sampleRate),
    sampled: normalizeBoolean(body.sampled, true),
    appVersion: normalizeString(body.appVersion, 64),
    buildSha: normalizeString(body.buildSha, 64),
    browserName: normalizeString(body.browserName, 64),
    deviceClass: normalizeString(body.deviceClass, 32),
    connectionType: normalizeString(body.connectionType, 32),
    occurredAt: normalizeString(body.occurredAt, 64),
  };

  const invalid =
    !ALLOWED_EVENT_TYPES.has(payload.eventType) ||
    payload.valueMs == null ||
    payload.valueMs < 0 ||
    payload.valueMs > 600000 ||
    payload.sampleRate == null ||
    payload.sampleRate < 0 ||
    payload.sampleRate > 1 ||
    !ALLOWED_RATINGS.has(payload.rating) ||
    !isIsoDate(payload.occurredAt);

  if (invalid) {
    return res.status(400).json({
      success: false,
      code: "INVALID_FRONTEND_PERF_PAYLOAD",
      message: "Invalid frontend performance payload.",
    });
  }

  logger.info("frontend_performance_event", payload);
  return res.status(202).json({ success: true });
}
