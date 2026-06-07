export const TERMINAL_METAFIELD_ERROR_CODES = Object.freeze([
  "STALE_OBJECT",
]);

export function isTerminalMetafieldError(errorCode) {
  return TERMINAL_METAFIELD_ERROR_CODES.includes(
    String(errorCode || "").trim().toUpperCase(),
  );
}
