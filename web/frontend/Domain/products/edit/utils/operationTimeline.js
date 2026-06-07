const LIFECYCLE_STAGE_KEYS = Object.freeze([
  "TARGET_FREEZING",
  "TARGET_FROZEN",
  "QUEUED",
  "WAITING_FOR_SHOPIFY_SLOT",
  "EXECUTING",
  "SHOPIFY_RUNNING",
  "SHOPIFY_COMPLETED",
  "INGESTING_RESULTS",
  "VERIFYING",
  "MIRROR_UPDATING",
  "ROLLING_BACK",
  "COMPLETED",
]);

const STAGE_LABELS = Object.freeze({
  TARGET_FREEZING: "Preparing targets",
  TARGET_FROZEN: "Targets frozen",
  QUEUED: "Queued",
  WAITING_FOR_SHOPIFY_SLOT: "Waiting for Shopify slot",
  EXECUTING: "Dispatching mutations",
  SHOPIFY_RUNNING: "Running in Shopify",
  SHOPIFY_COMPLETED: "Shopify operation completed",
  INGESTING_RESULTS: "Ingesting results",
  VERIFYING: "Verifying changes",
  VERIFICATION_TIMEOUT: "Verification timed out",
  ROLLING_BACK: "Rolling back",
  ROLLED_BACK: "Rolled back",
  ROLLBACK_FAILED: "Rollback failed",
  MIRROR_UPDATING: "Updating mirror",
  COMPLETED: "Completed",
  FAILED: "Failed",
  PARTIAL_FAILED: "Partially completed",
  CANCELLED: "Cancelled",
  UNKNOWN: "Unknown",
});

const TERMINAL_KEYS = new Set(["FAILED", "ROLLED_BACK", "ROLLBACK_FAILED", "PARTIAL_FAILED", "CANCELLED"]);

const STATE_ALIASES = Object.freeze({
  PLANNED: "QUEUED",
  DISPATCHING: "EXECUTING",
  AWAITING_SHOPIFY: "SHOPIFY_RUNNING",
  FINALIZING: "VERIFYING",
  ROLLING_BACK: "ROLLING_BACK",
});

function normalizeStateKey(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  return STATE_ALIASES[raw] || raw;
}

export function getLifecycleStageKeys() {
  return [...LIFECYCLE_STAGE_KEYS];
}

export function buildOperationTimeline(currentState) {
  const normalized = normalizeStateKey(currentState);
  const timeline = LIFECYCLE_STAGE_KEYS.map((key, index) => ({
    key,
    index,
    labelKey: `operationLifecycleStageLabels.${key}`,
    defaultLabel: STAGE_LABELS[key] || key,
    status: "pending",
  }));

  const activeIndex = timeline.findIndex((stage) => stage.key === normalized);
  const isTerminal = TERMINAL_KEYS.has(normalized);

  if (activeIndex >= 0) {
    for (let index = 0; index < timeline.length; index += 1) {
      if (index < activeIndex) timeline[index].status = "completed";
    }
    timeline[activeIndex].status = isTerminal ? "completed" : "active";
  }

  const extraTerminalStage =
    isTerminal && !timeline.some((stage) => stage.key === normalized)
      ? {
          key: normalized,
          index: timeline.length,
          labelKey: `operationLifecycleStageLabels.${normalized}`,
          defaultLabel: STAGE_LABELS[normalized] || normalized,
          status: "active",
        }
      : null;

  return {
    currentState: normalized || "UNKNOWN",
    stages: extraTerminalStage ? [...timeline, extraTerminalStage] : timeline,
  };
}
