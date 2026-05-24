import { prisma } from "../config/database.js";
import {
  BULK_EDIT_EXECUTION_STATES,
} from "./bulkEditExecutionStateService.js";
import {
  EXPORT_EXECUTION_STATES,
} from "./exportExecutionStateService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
} from "../utils/normalizedStateUtils.js";

function normalizeCancelReason(reason) {
  if (typeof reason !== "string") return null;
  const value = reason.trim();
  return value.length ? value.slice(0, 500) : null;
}

function buildStage(executionStateRaw) {
  const state = String(executionStateRaw || "").toUpperCase();
  if (state === "TARGETING_STARTED" || state === "TARGET_FREEZING") return "BEFORE_FREEZE";
  if (state === "TARGETING_FROZEN" || state === "TARGET_FROZEN" || state === "QUEUED_FOR_EXECUTION" || state === "QUEUED") return "AFTER_FREEZE_BEFORE_EXECUTION";
  if (state === "EXECUTING" || state === "SHOPIFY_BULK_SUBMITTED" || state === "SHOPIFY_RUNNING") return "DURING_EXECUTION";
  if (state === "SHOPIFY_COMPLETED" || state === "INGESTING_RESULTS" || state === "VERIFYING" || state === "MIRROR_UPDATING") return "DURING_VERIFICATION";
  if (state === BULK_EDIT_EXECUTION_STATES.FINALIZING || state === EXPORT_EXECUTION_STATES.FINALIZING) {
    return "DURING_VERIFICATION";
  }
  if (
    state === BULK_EDIT_EXECUTION_STATES.DISPATCHING
    || state === BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY
    || state === EXPORT_EXECUTION_STATES.RUNNING
  ) {
    return "DURING_EXECUTION";
  }
  if (
    state === BULK_EDIT_EXECUTION_STATES.COMPLETED
    || state === BULK_EDIT_EXECUTION_STATES.PARTIAL
    || state === "COMPLETED"
    || state === "PARTIAL_FAILED"
    || state === EXPORT_EXECUTION_STATES.COMPLETED
  ) {
    return "AFTER_EXECUTION";
  }
  return "UNKNOWN";
}

export async function requestEditHistoryCancellation({ shop, historyId, reason }) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      id: true,
      executionState: true,
      executionStateNormalized: true,
      statusNormalized: true,
      cancelRequestedAt: true,
    },
  });
  if (!history) throw new Error("Edit history not found");

  const stage = buildStage(history.executionState);
  const now = new Date();
  const cancelReason = normalizeCancelReason(reason);
  const update = {
    cancelRequestedAt: history.cancelRequestedAt || now,
    cancelReason,
  };

  if (stage === "BEFORE_FREEZE" || stage === "AFTER_FREEZE_BEFORE_EXECUTION") {
    Object.assign(update, {
      status: "cancelled",
      statusNormalized: normalizeEditHistoryStatus("CANCELLED"),
      executionState: BULK_EDIT_EXECUTION_STATES.CANCELLED,
      executionStateNormalized: normalizeEditHistoryExecutionState("CANCELLED"),
      cancelledAt: now,
      completedAt: now,
    });
  } else if (stage === "AFTER_EXECUTION") {
    const error = new Error("Execution already completed. Cancellation is not allowed; use undo.");
    error.code = "CANCEL_NOT_ALLOWED_AFTER_EXECUTION";
    throw error;
  }

  await prisma.editHistory.update({
    where: { id: history.id },
    data: update,
  });

  return {
    id: history.id,
    stage,
    cancellation: stage === "DURING_VERIFICATION"
      ? "VERIFICATION_STOP_REQUESTED"
      : stage === "DURING_EXECUTION"
        ? "STOP_AFTER_CURRENT_BATCH"
        : "CANCELLED",
  };
}

export async function requestExportJobCancellation({ shop, exportJobId, reason }) {
  const job = await prisma.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: {
      id: true,
      executionState: true,
      executionStateNormalized: true,
      statusNormalized: true,
      cancelRequestedAt: true,
    },
  });
  if (!job) throw new Error("Export job not found");
  const stage = buildStage(job.executionState);
  const now = new Date();
  const cancelReason = normalizeCancelReason(reason);
  const update = {
    cancelRequestedAt: job.cancelRequestedAt || now,
    cancelReason,
  };

  if (stage === "BEFORE_FREEZE" || stage === "AFTER_FREEZE_BEFORE_EXECUTION") {
    Object.assign(update, {
      status: "CANCELLED",
      statusNormalized: normalizeExportJobStatus("CANCELLED"),
      executionState: EXPORT_EXECUTION_STATES.CANCELLED,
      executionStateNormalized: normalizeExportJobExecutionState("CANCELLED"),
      cancelledAt: now,
      completedAt: now,
    });
  } else if (stage === "AFTER_EXECUTION") {
    const error = new Error("Execution already completed. Cancellation is not allowed.");
    error.code = "CANCEL_NOT_ALLOWED_AFTER_EXECUTION";
    throw error;
  }

  await prisma.exportJob.update({
    where: { id: job.id },
    data: update,
  });

  return {
    id: job.id,
    stage,
    cancellation: stage === "DURING_VERIFICATION"
      ? "VERIFICATION_STOP_REQUESTED"
      : stage === "DURING_EXECUTION"
        ? "STOP_AFTER_CURRENT_BATCH"
        : "CANCELLED",
  };
}
