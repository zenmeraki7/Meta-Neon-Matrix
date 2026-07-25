const FRONTEND_PERF_ENDPOINT = "/api/rum/frontend-performance-events";

const DEFAULT_SAMPLE_RATES = {
  web_vital: 0.15,
  route_timing: 0.1,
  api_timing: 0.05,
  interaction_timing: 0.1,
  render_timing: 0.1,
  polling_timing: 0.03,
};

const SEVERE_THRESHOLDS_MS = {
  INP: 500,
  LCP: 4000,
  CLS: 250,
  route_load: 3000,
  api_fetch: 5000,
};

function clampNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function sanitizeRoute(pathname) {
  const raw = String(pathname || "/").split("?")[0];
  return raw
    .replace(/\/\d+/g, "/:id")
    .replace(/\/gid:\/\/shopify\/[^/]+\/[^/]+/gi, "/:gid")
    .slice(0, 256);
}

function normalizeStatus(status) {
  const safe = String(status || "unknown").trim().toLowerCase();
  return safe.slice(0, 64) || "unknown";
}

function normalizeMetricName(metricName) {
  return String(metricName || "unknown").trim().slice(0, 64) || "unknown";
}

function bucketCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "unknown";
  if (parsed < 1000) return "lt_1k";
  if (parsed < 10000) return "1k_10k";
  if (parsed < 50000) return "10k_50k";
  if (parsed < 100000) return "50k_100k";
  if (parsed < 500000) return "100k_500k";
  return "gte_500k";
}

function bucketVariantCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "unknown";
  if (parsed < 10000) return "lt_10k";
  if (parsed < 100000) return "10k_100k";
  if (parsed < 500000) return "100k_500k";
  if (parsed < 1000000) return "500k_1m";
  return "gte_1m";
}

function bucketSmallCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return "unknown";
  if (parsed === 0) return "0";
  if (parsed <= 3) return "1_3";
  if (parsed <= 10) return "4_10";
  if (parsed <= 25) return "11_25";
  return "gt_25";
}

function shouldAlwaysLog(event) {
  const valueMs = clampNumber(event.valueMs, null);
  const metricName = normalizeMetricName(event.metricName).toUpperCase();

  if (event.success === false) return true;
  if (valueMs == null) return false;

  const threshold = SEVERE_THRESHOLDS_MS[metricName] ?? SEVERE_THRESHOLDS_MS[metricName.toLowerCase()];
  return Number.isFinite(threshold) && valueMs >= threshold;
}

function shouldSample(sampleRate) {
  return Math.random() < sampleRate;
}

function getSampleRate(domainEventType, overrideRate) {
  if (typeof overrideRate === "number") {
    return Math.min(1, Math.max(0, overrideRate));
  }
  const base = DEFAULT_SAMPLE_RATES[domainEventType] ?? 0.1;
  return Math.min(1, Math.max(0, base));
}

function getDeviceClass() {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.maxTouchPoints > 0 ? "touch" : "desktop";
}

function getBrowserName() {
  if (typeof navigator === "undefined") return "unknown";
  const brand = navigator.userAgentData?.brands?.[0]?.brand;
  if (brand) return String(brand).slice(0, 64);
  const ua = String(navigator.userAgent || "");
  if (/chrome/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua) && !/chrome/i.test(ua)) return "Safari";
  if (/firefox/i.test(ua)) return "Firefox";
  if (/edg/i.test(ua)) return "Edge";
  return "unknown";
}

function sendPayload(serialized) {
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const ok = navigator.sendBeacon(
      FRONTEND_PERF_ENDPOINT,
      new Blob([serialized], { type: "application/json" }),
    );
    if (ok) return;
  }

  void fetch(FRONTEND_PERF_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: serialized,
    keepalive: true,
  }).catch(() => {});
}

export function emitPerformanceTelemetry(event, options = {}) {
  if (typeof window === "undefined") return;

  const domainEventType = String(event?.domainEventType || "web_vital").trim().slice(0, 64);
  const metricName = normalizeMetricName(event?.metricName);
  const sampleRate = getSampleRate(domainEventType, options.sampleRate);

  if (!shouldAlwaysLog(event) && !shouldSample(sampleRate)) {
    return;
  }

  const payload = {
    domainEventType,
    metricName,
    valueMs: Math.round(clampNumber(event?.valueMs)),
    valueUnit: String(event?.valueUnit || "ms").slice(0, 16),
    rating: String(event?.rating || "unknown").slice(0, 32),
    routeGroup: String(event?.routeGroup || "unknown").slice(0, 64),
    routePattern: sanitizeRoute(window.location.pathname),
    productCountBucket: event?.productCountBucket || bucketCount(event?.productCount),
    variantCountBucket: event?.variantCountBucket || bucketVariantCount(event?.variantCount),
    filterCountBucket: event?.filterCountBucket || bucketSmallCount(event?.filterCount),
    rowCountBucket: event?.rowCountBucket || bucketSmallCount(event?.rowCount),
    payloadSizeBucket: String(event?.payloadSizeBucket || "unknown").slice(0, 32),
    success: event?.success !== false,
    status: normalizeStatus(event?.status),
    sampleRate,
    sampled: true,
    appVersion: String(import.meta.env.VITE_APP_VERSION || "unknown").slice(0, 64),
    buildSha: String(import.meta.env.VITE_BUILD_SHA || "unknown").slice(0, 64),
    browserName: getBrowserName(),
    deviceClass: getDeviceClass(),
    connectionType: String(navigator.connection?.effectiveType || "unknown").slice(0, 32),
    occurredAt: new Date().toISOString(),
  };

  sendPayload(JSON.stringify(payload));
}

