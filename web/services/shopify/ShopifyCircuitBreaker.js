const DEFAULT_COOLDOWN_MS = Number(
  process.env.SHOPIFY_CIRCUIT_COOLDOWN_MS || 5 * 60 * 1000,
);
const circuits = new Map();

function errorStatus(error) {
  return Number(
    error?.status
      || error?.statusCode
      || error?.response?.status
      || error?.response?.statusCode
      || error?.response?.code
      || 0,
  );
}

function retryAfterMs(error, nowMs) {
  const value =
    error?.retryAfter
    || error?.response?.headers?.["retry-after"]
    || error?.response?.headers?.get?.("retry-after");
  if (value instanceof Date) return Math.max(0, value.getTime() - nowMs);
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.max(0, parsed - nowMs) : DEFAULT_COOLDOWN_MS;
}

export function isShopifyInfrastructureError(error) {
  const status = errorStatus(error);
  if ([500, 502, 503, 504].includes(status)) return true;
  const message = String(error?.message || "").toLowerCase();
  return [
    "econnrefused",
    "econnreset",
    "enotfound",
    "etimedout",
    "fetch failed",
    "network error",
    "socket hang up",
    "temporarily unavailable",
    "service unavailable",
    "gateway timeout",
  ].some((token) => message.includes(token));
}

export class CircuitOpenError extends Error {
  constructor(shop, retryAfter, cause = null) {
    super("SHOPIFY_UNAVAILABLE");
    this.name = "CircuitOpenError";
    this.code = "SHOPIFY_UNAVAILABLE";
    this.shop = shop;
    this.retryAfter = retryAfter;
    this.retryable = true;
    this.cause = cause;
  }
}

export async function executeWithShopifyCircuit(
  shop,
  apiFn,
  { nowFn = Date.now } = {},
) {
  const key = String(shop || "").trim();
  const nowMs = nowFn();
  const existing = circuits.get(key);
  if (existing?.openUntilMs > nowMs) {
    throw new CircuitOpenError(key, new Date(existing.openUntilMs));
  }

  try {
    const result = await apiFn();
    circuits.delete(key);
    return result;
  } catch (error) {
    if (!isShopifyInfrastructureError(error)) throw error;
    const openUntilMs = nowMs + retryAfterMs(error, nowMs);
    circuits.set(key, { openUntilMs });
    throw new CircuitOpenError(key, new Date(openUntilMs), error);
  }
}

export function clearShopifyCircuitsForTests() {
  circuits.clear();
}
