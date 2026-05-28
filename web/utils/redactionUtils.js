const SENSITIVE_KEY_PATTERN =
  /(accessToken|access_token|authorization|token|password|secret|cookie|set-cookie|x-shopify-access-token|x-shopify-hmac-sha256|x-shopify-topic|x-shopify-shop-domain|session|body|rawBody)/i;

function redactPrimitive(value) {
  if (typeof value === "string") {
    if (value.length <= 8) return "[REDACTED]";
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return "[REDACTED]";
}

export function redactSensitive(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return "[MAX_DEPTH]";

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }

  if (typeof value === "object") {
    const output = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = redactPrimitive(val);
      } else {
        output[key] = redactSensitive(val, depth + 1);
      }
    }
    return output;
  }

  return value;
}
