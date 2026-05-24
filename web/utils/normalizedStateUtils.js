import { normalizeLifecycleToEditExecutionState } from "../services/operationLifecycleStateMachine.js";

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeEditHistoryExecutionState(value) {
  const lifecycleMapped = normalizeLifecycleToEditExecutionState(value);
  const v = upper(lifecycleMapped === "UNKNOWN" ? value : lifecycleMapped);
  switch (v) {
    case "PLANNED":
    case "QUEUED":
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
    case "RUNNING":
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
