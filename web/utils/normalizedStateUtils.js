import { OPERATION_LIFECYCLE_STATES } from "../services/operationLifecycleStateMachine.js";

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeExecutionStateLiteral(value) {
  const v = upper(value);
  const legacyToLifecycle = {
    TARGETING_STARTED: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    TARGETING_FROZEN: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
    QUEUED_FOR_EXECUTION: OPERATION_LIFECYCLE_STATES.QUEUED,
  };
  return legacyToLifecycle[v] || v;
}

export function normalizeEditHistoryExecutionState(value) {
  const v = normalizeExecutionStateLiteral(value);
  const canonicalLifecycleStates = new Set(Object.values(OPERATION_LIFECYCLE_STATES));
  if (canonicalLifecycleStates.has(v)) return v;
  switch (v) {
    case "PLANNED":
    case "QUEUED":
    case "PAUSED":
    case "DISPATCHING":
    case "AWAITING_SHOPIFY":
    case "FINALIZING":
    case "COMPLETED":
    case "FAILED":
    case "PARTIAL":
    case "CANCELLED":
      return v;
    default:
      return "UNKNOWN";
  }
}

export function normalizeEditHistoryStatus(value) {
  const v = upper(value).replace(/\s+/g, "_");
  switch (v) {
    case "PENDING":
    case "PROCESSING":
    case "COMPLETED":
    case "FAILED":
    case "PARTIAL":
    case "UNDO_PENDING":
    case "CANCELLED":
      return v;
    default:
      return "UNKNOWN";
  }
}

export function normalizeExportJobExecutionState(value) {
  const v = upper(value);
  switch (v) {
    case "PLANNED":
    case "QUEUED":
    case "PAUSED":
    case "RUNNING":
    case "FINALIZING":
    case "COMPLETED":
    case "FAILED":
    case "CANCELLED":
    case "UNKNOWN":
      return v;
    case "PARTIAL":
      return "FAILED";
    default:
      return "UNKNOWN";
  }
}

export function normalizeExportJobStatus(value) {
  const v = upper(value);
  switch (v) {
    case "PENDING":
    case "PROCESSING":
    case "COMPLETED":
    case "FAILED":
    case "CANCELLED":
      return v;
    default:
      return "UNKNOWN";
  }
}

export function normalizeWebhookDeliveryStatus(value) {
  const v = upper(value);
  switch (v) {
    case "RECEIVED":
    case "QUEUED":
    case "PROCESSING":
    case "PROCESSED":
    case "FAILED":
    case "IGNORED":
      return v;
    default:
      return "UNKNOWN";
  }
}
