export const BULK_EDIT_EXECUTION_STATES = {
  PLANNED: "planned",
  QUEUED: "queued",
  DISPATCHING: "dispatching",
  AWAITING_SHOPIFY: "awaiting_shopify",
  FINALIZING: "finalizing",
  COMPLETED: "completed",
  FAILED: "failed",
  PARTIAL: "partial",
  CANCELLED: "cancelled",
};

export const BULK_UNDO_STATES = {
  PLANNED: "planned",
  QUEUED: "queued",
  DISPATCHING: "dispatching",
  AWAITING_SHOPIFY: "awaiting_shopify",
  FINALIZING: "finalizing",
  COMPLETED: "completed",
  FAILED: "failed",
  PARTIAL: "partial",
  CANCELLED: "cancelled",
};

export function normalizeUndoState(value, fallback = {}) {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
  return {
    ...raw,
    outcomeStatus: raw.outcomeStatus ?? raw.status ?? "idle",
    executionState: raw.executionState ?? raw.state ?? BULK_UNDO_STATES.PLANNED,
  };
}

export function isTerminalExecutionState(state) {
  return [
    BULK_EDIT_EXECUTION_STATES.COMPLETED,
    BULK_EDIT_EXECUTION_STATES.FAILED,
    BULK_EDIT_EXECUTION_STATES.PARTIAL,
    BULK_EDIT_EXECUTION_STATES.CANCELLED,
  ].includes(state);
}

export function isTerminalUndoState(state) {
  return [
    BULK_UNDO_STATES.COMPLETED,
    BULK_UNDO_STATES.FAILED,
    BULK_UNDO_STATES.PARTIAL,
    BULK_UNDO_STATES.CANCELLED,
  ].includes(state);
}

export function buildExecutionError({
  code,
  stage,
  message,
  retryable = false,
  details = null,
}) {
  return {
    code,
    stage,
    message,
    retryable,
    details: details ?? null,
    occurredAt: new Date().toISOString(),
  };
}

export function appendExecutionError(existing, entry) {
  if (!existing) {
    return [entry];
  }

  if (Array.isArray(existing)) {
    return [...existing, entry];
  }

  return [existing, entry];
}

export function buildPlannedUndoState({ allowed, executionIdentity = null }) {
  return {
    allowed: Boolean(allowed),
    outcomeStatus: "idle",
    executionState: BULK_UNDO_STATES.PLANNED,
    executionIdentity,
    processedCount: 0,
    durationMs: 0,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    shopifyBulkOperationId: null,
    error: null,
  };
}
