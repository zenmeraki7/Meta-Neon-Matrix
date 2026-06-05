import crypto from "crypto";

function assertJsonValue(value, path, seen) {
  const type = typeof value;
  if (
    value === undefined ||
    type === "function" ||
    type === "symbol" ||
    type === "bigint"
  ) {
    throw new Error(`NON_JSON_VALUE:${path}`);
  }
  if (type === "number" && !Number.isFinite(value)) {
    throw new Error(`NON_JSON_NUMBER:${path}`);
  }
  if (value === null || type !== "object") {
    return;
  }
  if (seen.has(value)) {
    throw new Error(`CIRCULAR_JSON_VALUE:${path}`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  for (const key of Object.keys(value)) {
    assertJsonValue(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
}

export function assertJsonSerializable(value, path = "$") {
  assertJsonValue(value, path, new WeakSet());
}

export function stableStringify(value) {
  assertJsonSerializable(value);
  return stableStringifyUnchecked(value);
}

function stableStringifyUnchecked(value) {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyUnchecked(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringifyUnchecked(value[key])}`)
    .join(",")}}`;
}

export function sha256Stable(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function hmacSha256Stable(value, secret) {
  const safeSecret = String(secret || "");
  if (!safeSecret) {
    throw new Error("HMAC_SECRET_REQUIRED");
  }
  return crypto
    .createHmac("sha256", safeSecret)
    .update(stableStringify(value))
    .digest("hex");
}
