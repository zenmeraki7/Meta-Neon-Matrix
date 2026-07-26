const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~:/+-]+$/;

export function getRequiredIdempotencyKey(req) {
  const rawValue = req.get("Idempotency-Key");

  if (typeof rawValue !== "string") {
    const error = new Error("Idempotency-Key header is required");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }

  const value = rawValue.trim();

  if (
    !value ||
    value.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    const error = new Error("Idempotency-Key header is invalid");
    error.code = value ? "INVALID_IDEMPOTENCY_KEY" : "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }

  return value;
}
