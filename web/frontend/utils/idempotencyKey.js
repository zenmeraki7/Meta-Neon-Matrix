function fallbackKey() {
  return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function generateIdempotencyKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return fallbackKey();
}
