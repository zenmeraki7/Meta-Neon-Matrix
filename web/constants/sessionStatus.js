export const TERMINAL_SESSION_STATUSES = Object.freeze(["DONE", "PARTIAL", "FAILED"]);

const TERMINAL_SESSION_STATUS_SET = new Set(TERMINAL_SESSION_STATUSES);

export function isTerminalSessionStatus(status) {
  return TERMINAL_SESSION_STATUS_SET.has(String(status || "").toUpperCase());
}

