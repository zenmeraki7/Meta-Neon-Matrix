import {
  BULK_EDIT_EXECUTION_STATES,
  BULK_UNDO_STATES,
  normalizeUndoState,
} from "./bulkEditExecutionStateService.js";
import {
  EXPORT_EXECUTION_STATES,
  parseSerializedExportError,
} from "./exportExecutionStateService.js";
import { OPERATION_LIFECYCLE_STATES } from "./operationLifecycleStateMachine.js";
import { normalizeExecutionStateLiteral } from "../utils/normalizedStateUtils.js";
const LEGACY_COMPAT = Object.freeze({
  undoStatusFallback: String(process.env.ENABLE_LEGACY_UNDO_STATUS_FALLBACK || "false").toLowerCase() === "true",
});
const TIMELINE_STAGE_KEYS = Object.freeze([
  "TARGET_FREEZING",
  "TARGET_FROZEN",
  "QUEUED",
  "WAITING_FOR_SHOPIFY_SLOT",
  "EXECUTING",
  "RECONCILE_SUBMITTED",
  "SHOPIFY_RUNNING",
  "SHOPIFY_COMPLETED",
  "INGESTING_RESULTS",
  "VERIFYING",
  "MIRROR_UPDATING",
  "COMPLETED",
]);
const TIMELINE_STATE_ALIASES = Object.freeze({
  PLANNED: "QUEUED",
  DISPATCHING: "EXECUTING",
  AWAITING_SHOPIFY: "SHOPIFY_RUNNING",
  FINALIZING: "VERIFYING",
});
const TERMINAL_TIMELINE_KEYS = new Set(["FAILED", "PARTIAL_FAILED", "CANCELLED"]);

function normalizeTimelineState(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "UNKNOWN";
  return TIMELINE_STATE_ALIASES[raw] || raw;
}

function buildTimelineSummary(executionState, idempotencyStages = []) {
  const currentState = normalizeTimelineState(executionState);
  const stages = TIMELINE_STAGE_KEYS.map((key, index) => ({
    key,
    index,
    labelKey: `operationLifecycleStageLabels.${key}`,
    defaultLabel: key.replaceAll("_", " "),
    status: "pending",
  }));
  const activeIndex = stages.findIndex((stage) => stage.key === currentState);

  if (activeIndex >= 0) {
    for (let index = 0; index < stages.length; index += 1) {
      if (index < activeIndex) stages[index].status = "completed";
    }
    stages[activeIndex].status = TERMINAL_TIMELINE_KEYS.has(currentState) ? "completed" : "active";
  }

  const stageMeta = new Map(
    (Array.isArray(idempotencyStages) ? idempotencyStages : []).map((stage) => [String(stage?.stage || ""), stage]),
  );

  const stageBadges = stages.slice(0, 5).map((stage) => {
    const meta = stageMeta.get(stage.key) || null;
    return {
      key: stage.key,
      status: stage.status,
      labelKey: stage.labelKey,
      defaultLabel: stage.defaultLabel,
      startedAt: meta?.startedAt || null,
      updatedAt: meta?.updatedAt || null,
      completedAt: meta?.completedAt || null,
      leaseUntil: meta?.leaseUntil || null,
    };
  });

  const activeStage = stages.find((stage) => stage.status === "active") || null;
  return {
    currentState,
    activeStageLabelKey: activeStage?.labelKey || `operationLifecycleStageLabels.${currentState}`,
    activeStageDefaultLabel: activeStage?.defaultLabel || currentState,
    stageBadges,
  };
}

function parseHistoryErrors(value) {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (typeof value === "object") {
    return [value];
  }

  return [{ message: String(value) }];
}

function normalizeIdempotencyStages(batchValue) {
  const batch = batchValue && typeof batchValue === "object" && !Array.isArray(batchValue)
    ? batchValue
    : {};
  const rawStages = batch.idempotencyStages && typeof batch.idempotencyStages === "object"
    ? batch.idempotencyStages
    : {};
  const entries = Object.entries(rawStages)
    .map(([stage, value]) => {
      const stageState = value && typeof value === "object" ? value : {};
      return {
        stage,
        key: stageState.key || null,
        status: stageState.status || null,
        attempts: Number(stageState.attempts || 0),
        startedAt: stageState.startedAt || null,
        updatedAt: stageState.updatedAt || null,
        completedAt: stageState.completedAt || null,
        leaseUntil: stageState.leaseUntil || null,
        recovered: stageState.recovered === true,
        checkpoint: stageState.checkpoint ?? null,
        error: stageState.error || null,
      };
    })
    .sort((a, b) => String(a.stage).localeCompare(String(b.stage)));
  return entries;
}

function buildStatusSummary({
  key,
  label,
  labelKey = null,
  tone,
  detail = null,
  detailKey = null,
  isTerminal = false,
}) {
  return {
    key,
    label,
    labelKey,
    tone,
    detail,
    detailKey,
    isTerminal,
  };
}

function buildMerchantSafetyState(record, undo, primaryStatus) {
  const rawExecutionState = normalizeExecutionStateLiteral(record.executionState);
  const normalizedExecutionState = String(record.executionStateNormalized || "").toUpperCase();
  const statusNormalized = String(record.statusNormalized || "").toUpperCase();
  const processedCount = Number(record.processedCount || 0);
  const batch = record.batch && typeof record.batch === "object" ? record.batch : {};
  const verificationStatus = String(batch.verificationStatus || "").toUpperCase();
  const conflictCount = Number(batch.conflictDetectedCount || 0);
  const undoConflicts = Number(
    undo?.conflictReport?.conflictCount
    || undo?.conflictStorage?.conflictTotal
    || 0,
  );

  if (rawExecutionState === OPERATION_LIFECYCLE_STATES.TARGET_FREEZING) return "Preparing targets";
  if (rawExecutionState === OPERATION_LIFECYCLE_STATES.TARGET_FROZEN) return "Targets frozen";
  if (rawExecutionState === "PAUSED") return "Paused";
  if (rawExecutionState === OPERATION_LIFECYCLE_STATES.QUEUED || normalizedExecutionState === "QUEUED" || normalizedExecutionState === "PLANNED") {
    return "Queued";
  }
  if (normalizedExecutionState === "DISPATCHING" || normalizedExecutionState === "AWAITING_SHOPIFY") {
    return "Editing products";
  }
  if (normalizedExecutionState === "FINALIZING" || verificationStatus === "PENDING") {
    return "Verifying changes";
  }
  if (normalizedExecutionState === "CANCELLED" || statusNormalized === "CANCELLED") {
    return "Cancelled";
  }
  if (normalizedExecutionState === "FAILED" || statusNormalized === "FAILED") {
    return processedCount > 0 ? "Failed after partial edit" : "Failed before editing";
  }
  if (normalizedExecutionState === "PARTIAL" || statusNormalized === "PARTIAL" || conflictCount > 0 || verificationStatus === "PARTIAL" || verificationStatus === "FAILED") {
    return "Completed with failures";
  }
  if (normalizedExecutionState === "COMPLETED" || statusNormalized === "COMPLETED") {
    if (undo?.allowed && undoConflicts > 0) return "Undo partially available";
    if (undo?.allowed) return "Undo available";
    return "Completed";
  }

  if (primaryStatus?.key === "queued") return "Queued";
  if (primaryStatus?.key === "dispatching" || primaryStatus?.key === "awaiting_shopify") {
    return "Editing products";
  }
  return primaryStatus?.label || "Queued";
}

function mapBulkEditExecutionSummary(executionState) {
  switch (executionState) {
    case BULK_EDIT_EXECUTION_STATES.PLANNED:
    case BULK_EDIT_EXECUTION_STATES.QUEUED:
      return buildStatusSummary({
        key: "queued",
        label: "Queued",
        labelKey: "historyStatus.queued",
        tone: "attention",
        detail: "Waiting for execution.",
        detailKey: "historyStatusDetail.queued",
      });

      
    case BULK_EDIT_EXECUTION_STATES.DISPATCHING:
      return buildStatusSummary({
        key: "dispatching",
        label: "Dispatching",
        labelKey: "historyStatus.dispatching",
        tone: "info",
        detail: "Preparing the next Shopify mutation batch.",
        detailKey: "historyStatusDetail.dispatching",
      });

    case BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY:
      return buildStatusSummary({
        key: "awaiting_shopify",
        label: "Running in Shopify",
        labelKey: "historyStatus.awaiting_shopify",
        tone: "info",
        detail: "Waiting for Shopify bulk operation completion.",
        detailKey: "historyStatusDetail.awaiting_shopify",
      });

    case BULK_EDIT_EXECUTION_STATES.FINALIZING:
      return buildStatusSummary({
        key: "finalizing",
        label: "Finalizing",
        labelKey: "historyStatus.finalizing",
        tone: "info",
        detail: "Applying the completion results safely.",
        detailKey: "historyStatusDetail.finalizing",
      });

    case BULK_EDIT_EXECUTION_STATES.COMPLETED:
      return buildStatusSummary({
        key: "completed",
        label: "Completed",
        labelKey: "historyStatus.completed",
        tone: "success",
        isTerminal: true,
      });

    case BULK_EDIT_EXECUTION_STATES.PARTIAL:
      return buildStatusSummary({
        key: "partial",
        label: "Partially completed",
        labelKey: "historyStatus.partial",
        tone: "attention",
        detail: "Some batches finished, but errors were recorded.",
        detailKey: "historyStatusDetail.partial",
        isTerminal: true,
      });

    case BULK_EDIT_EXECUTION_STATES.FAILED:
      return buildStatusSummary({
        key: "failed",
        label: "Failed",
        labelKey: "historyStatus.failed",
        tone: "critical",
        isTerminal: true,
      });

    case BULK_EDIT_EXECUTION_STATES.CANCELLED:
      return buildStatusSummary({
        key: "cancelled",
        label: "Cancelled",
        labelKey: "historyStatus.cancelled",
        tone: "critical",
        isTerminal: true,
      });

    default: {
      return buildStatusSummary({
        key: "unknown",
        label: "Unknown",
        labelKey: "historyStatus.unknown",
        tone: "critical",
        detail: "Status projection requires normalized execution state.",
        detailKey: "historyStatusDetail.unknown",
      });
    }
  }
}

function mapBulkUndoSummary(undoValue) {
  const undo = normalizeUndoState(undoValue, {
    allowed: false,
    status: "idle",
    state: BULK_UNDO_STATES.PLANNED,
    processedCount: 0,
    error: null,
  });

  const state = undo.state || BULK_UNDO_STATES.PLANNED;

  switch (state) {
    case BULK_UNDO_STATES.QUEUED:
    case BULK_UNDO_STATES.CHANGE_RECORDS_PENDING:
      return buildStatusSummary({
        key: "undo_queued",
        label: "Undo queued",
        labelKey: "historyStatus.undo_queued",
        tone: "attention",
        detail: "Waiting to undo this edit safely.",
        detailKey: "historyStatusDetail.undo_queued",
      });

    case BULK_UNDO_STATES.DISPATCHING:
      return buildStatusSummary({
        key: "undo_dispatching",
        label: "Undo dispatching",
        labelKey: "historyStatus.undo_dispatching",
        tone: "info",
        detail: "Preparing the undo mutation batch.",
        detailKey: "historyStatusDetail.undo_dispatching",
      });

    case BULK_UNDO_STATES.AWAITING_CONFIRMATION:
      return buildStatusSummary({
        key: "undo_awaiting_confirmation",
        label: "Undo needs confirmation",
        labelKey: "historyStatus.undo_awaiting_confirmation",
        tone: "attention",
        detail: "Review detected conflicts before continuing the undo.",
        detailKey: "historyStatusDetail.undo_awaiting_confirmation",
      });

    case BULK_UNDO_STATES.RECONCILE_SUBMITTED:
      return buildStatusSummary({
        key: "undo_reconcile_submitted",
        label: "Undo submission reconciling",
        labelKey: "historyStatus.undo_reconcile_submitted",
        tone: "attention",
        detail: "Shopify accepted the undo; waiting to reconcile its status.",
        detailKey: "historyStatusDetail.undo_reconcile_submitted",
      });

    case BULK_UNDO_STATES.AWAITING_SHOPIFY:
      return buildStatusSummary({
        key: "undo_awaiting_shopify",
        label: "Undo running in Shopify",
        labelKey: "historyStatus.undo_awaiting_shopify",
        tone: "info",
        detail: "Waiting for Shopify undo completion.",
        detailKey: "historyStatusDetail.undo_awaiting_shopify",
      });

    case BULK_UNDO_STATES.FINALIZING:
      return buildStatusSummary({
        key: "undo_finalizing",
        label: "Undo finalizing",
        labelKey: "historyStatus.undo_finalizing",
        tone: "info",
        detail: "Applying undo completion results safely.",
        detailKey: "historyStatusDetail.undo_finalizing",
      });

    case BULK_UNDO_STATES.COMPLETED:
      return buildStatusSummary({
        key: "undo_completed",
        label: "Undo completed",
        labelKey: "historyStatus.undo_completed",
        tone: "success",
        isTerminal: true,
      });

    case BULK_UNDO_STATES.PARTIAL:
      return buildStatusSummary({
        key: "undo_partial",
        label: "Undo partially completed",
        labelKey: "historyStatus.undo_partial",
        tone: "attention",
        detail: "Undo finished with recorded errors.",
        detailKey: "historyStatusDetail.undo_partial",
        isTerminal: true,
      });

    case BULK_UNDO_STATES.FAILED:
      return buildStatusSummary({
        key: "undo_failed",
        label: "Undo failed",
        labelKey: "historyStatus.undo_failed",
        tone: "critical",
        isTerminal: true,
      });

    case BULK_UNDO_STATES.CANCELLED:
      return buildStatusSummary({
        key: "undo_cancelled",
        label: "Undo cancelled",
        labelKey: "historyStatus.undo_cancelled",
        tone: "critical",
        isTerminal: true,
      });

    default: {
      if (!LEGACY_COMPAT.undoStatusFallback) {
        return null;
      }
      const legacyStatus = String(undo.status || "").toLowerCase();

      if (!legacyStatus || legacyStatus === "idle") {
        return null;
      }

      if (legacyStatus === "completed") {
        return buildStatusSummary({
          key: "undo_completed",
          label: "Undo completed",
          labelKey: "historyStatus.undo_completed",
          tone: "success",
          isTerminal: true,
        });
      }

      if (legacyStatus === "failed") {
        return buildStatusSummary({
          key: "undo_failed",
          label: "Undo failed",
          labelKey: "historyStatus.undo_failed",
          tone: "critical",
          isTerminal: true,
        });
      }

      return buildStatusSummary({
        key: "undo_processing",
        label: "Undo processing",
        labelKey: "historyStatus.undo_processing",
        tone: "info",
        detail: "Undo is still running.",
        detailKey: "historyStatusDetail.undo_processing",
      });
    }
  }
}

function buildProgressSummary({
  processedCount,
  totalItems,
  fallbackPercent = 0,
  statusLabel,
}) {
  const current = Number(processedCount || 0);
  const total = Number(totalItems || 0);
  const percent =
    total > 0
      ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
      : fallbackPercent;

  return {
    current,
    total,
    percent,
    label:
      total > 0
        ? `${current} / ${total}`
        : current > 0
        ? `${current}`
        : statusLabel,
  };
}

function getExportProgressPercent(executionState, processedCount, totalItems) {
  const exact = buildProgressSummary({
    processedCount,
    totalItems,
    fallbackPercent: 0,
    statusLabel: "Queued",
  }).percent;

  if (exact > 0) return exact;

  switch (executionState) {
    case EXPORT_EXECUTION_STATES.PLANNED:
    case EXPORT_EXECUTION_STATES.QUEUED:
      return 5;
    case EXPORT_EXECUTION_STATES.RUNNING:
      return 60;
    case EXPORT_EXECUTION_STATES.FINALIZING:
      return 90;
    case EXPORT_EXECUTION_STATES.COMPLETED:
      return 100;
    default:
      return 0;
  }
}

function mapExportExecutionSummary(executionState) {
  switch (executionState) {
    case EXPORT_EXECUTION_STATES.PLANNED:
    case EXPORT_EXECUTION_STATES.QUEUED:
      return buildStatusSummary({
        key: "queued",
        label: "Queued",
        labelKey: "historyStatus.queued",
        tone: "attention",
        detail: "Waiting for export execution.",
        detailKey: "historyStatusDetail.export_queued",
      });

    case EXPORT_EXECUTION_STATES.RUNNING:
      return buildStatusSummary({
        key: "running",
        label: "Building file",
        labelKey: "historyStatus.running",
        tone: "info",
        detail: "Export rows are being generated.",
        detailKey: "historyStatusDetail.export_running",
      });

    case EXPORT_EXECUTION_STATES.FINALIZING:
      return buildStatusSummary({
        key: "finalizing",
        label: "Uploading file",
        labelKey: "historyStatus.finalizing",
        tone: "info",
        detail: "Final file upload and completion write are in progress.",
        detailKey: "historyStatusDetail.export_finalizing",
      });

    case EXPORT_EXECUTION_STATES.COMPLETED:
      return buildStatusSummary({
        key: "completed",
        label: "Completed",
        labelKey: "historyStatus.completed",
        tone: "success",
        isTerminal: true,
      });

    case EXPORT_EXECUTION_STATES.PARTIAL:
      return buildStatusSummary({
        key: "partial",
        label: "Partially completed",
        labelKey: "historyStatus.partial",
        tone: "attention",
        detail: "The export finished with recorded issues.",
        detailKey: "historyStatusDetail.export_partial",
        isTerminal: true,
      });

    case EXPORT_EXECUTION_STATES.FAILED:
      return buildStatusSummary({
        key: "failed",
        label: "Failed",
        labelKey: "historyStatus.failed",
        tone: "critical",
        isTerminal: true,
      });

    case EXPORT_EXECUTION_STATES.CANCELLED:
      return buildStatusSummary({
        key: "cancelled",
        label: "Cancelled",
        labelKey: "historyStatus.cancelled",
        tone: "critical",
        isTerminal: true,
      });

    default: {
      return buildStatusSummary({
        key: "unknown",
        label: "Unknown",
        labelKey: "historyStatus.unknown",
        tone: "critical",
        detail: "Status projection requires normalized execution state.",
        detailKey: "historyStatusDetail.unknown",
      });
    }
  }
}

export function projectEditHistoryStatus(record) {
  const executionState = record.executionStateNormalized
    ? String(record.executionStateNormalized).toLowerCase()
    : null;
  const primaryStatus = mapBulkEditExecutionSummary(executionState);
  const undoStatus = mapBulkUndoSummary(record.undo);
  const errors = parseHistoryErrors(record.error);

  const undo = normalizeUndoState(record.undo, {
    allowed: false,
    status: "idle",
    state: BULK_UNDO_STATES.PLANNED,
    error: null,
    processedCount: 0,
  });

  const undoErrors = parseHistoryErrors(undo.error);

  const progress = buildProgressSummary({
    processedCount: record.processedCount,
    totalItems: record.targetSnapshotCount || record.totalItems,
    fallbackPercent: primaryStatus.key === "completed" ? 100 : 0,
    statusLabel: primaryStatus.label,
  });
  const merchantSafetyState = buildMerchantSafetyState(record, undo, primaryStatus);
  const idempotencyStages = normalizeIdempotencyStages(record.batch);

  return {
    ...record,
    primaryStatus,
    undoStatusSummary: undoStatus,
    progressSummary: progress,
    progressCount: progress.current,
    displayStatus: primaryStatus.key,
    merchantSafetyState,
    supportStatus: {
      executionState,
      failureStage: record.failureStage || null,
      executionIdentity: record.executionIdentity || null,
      targetSnapshotCount: Number(record.targetSnapshotCount || 0),
      targetMirrorBatchId: record.targetMirrorBatchId || null,
      errors,
      lastError: errors[errors.length - 1] || null,
      undoState: undo.state || null,
      undoAllowed: Boolean(undo.allowed),
      undoErrors,
      lastUndoError: undoErrors[undoErrors.length - 1] || null,
      idempotencyStages,
    },
    timelineSummary: buildTimelineSummary(executionState, idempotencyStages),
  };
}

export function projectExportHistoryStatus(record) {
  const executionState = record.executionStateNormalized
    ? String(record.executionStateNormalized).toLowerCase()
    : null;
  const primaryStatus = mapExportExecutionSummary(executionState);
  const errors = parseSerializedExportError(record.error);

  const progress = buildProgressSummary({
    processedCount: record.processedCount || record.totalItems || 0,
    totalItems: record.targetSnapshotCount || record.totalItems || 0,
    fallbackPercent: getExportProgressPercent(
      executionState,
      record.processedCount || record.totalItems || 0,
      record.targetSnapshotCount || record.totalItems || 0,
    ),
    statusLabel: primaryStatus.label,
  });

  return {
    ...record,
    _id: record.id,
    primaryStatus,
    progressSummary: progress,
    progressPercent: progress.percent,
    displayStatus: primaryStatus.key,
    supportStatus: {
      executionState,
      failureStage: record.failureStage || null,
      targetSnapshotCount: Number(record.targetSnapshotCount || 0),
      targetMirrorBatchId: record.targetMirrorBatchId || null,
      errors,
      lastError: errors[errors.length - 1] || null,
    },
  };
}
