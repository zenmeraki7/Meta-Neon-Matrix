import { prisma } from "../config/database.js";
import { addbulkEditJob } from "../Jobs/Queues/bulkEditJob.js";
import { addbulkExportJob } from "../Jobs/Queues/bulkExportJob.js";
import { BULK_EDIT_EXECUTION_STATES } from "./bulkEditExecutionStateService.js";
import { EXPORT_EXECUTION_STATES } from "./exportExecutionStateService.js";
import {
  normalizeExecutionStateLiteral,
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
} from "../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "./operationLifecycleStateMachine.js";

function normalizeToLifecycleState(rawState) {
  return normalizeExecutionStateLiteral(rawState);
}

function assertPremiumPlan(subscription = {}) {
  const plan = String(subscription?.planKey || "").toUpperCase();
  const premium = plan.includes("ADVANCED") || plan.includes("PRO") || plan.includes("ENTERPRISE");
  if (!premium) {
    const error = new Error("Pause/resume is available on Advanced, Pro, and Enterprise plans.");
    error.code = "PREMIUM_FEATURE_REQUIRED";
    throw error;
  }
}

export async function requestPauseEditOperation({ shop, historyId, subscription }) {
  assertPremiumPlan(subscription);
  const history = await prisma.editHistory.findFirst({ where: { id: historyId, shop } });
  if (!history) throw new Error("Edit history not found");
  const state = normalizeToLifecycleState(history.executionState);
  const now = new Date();
  if ([BULK_EDIT_EXECUTION_STATES.COMPLETED, BULK_EDIT_EXECUTION_STATES.CANCELLED, BULK_EDIT_EXECUTION_STATES.FAILED, BULK_EDIT_EXECUTION_STATES.PARTIAL, "COMPLETED", "CANCELLED", "FAILED", "PARTIAL_FAILED"].includes(state)) {
    throw new Error("Cannot pause a completed/cancelled/failed operation.");
  }
  const immediate = [
    OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
    OPERATION_LIFECYCLE_STATES.QUEUED,
    OPERATION_LIFECYCLE_STATES.PLANNED,
    OPERATION_LIFECYCLE_STATES.PLANNING,
  ].includes(state);
  await prisma.editHistory.updateMany({
    where: { id: historyId, shop },
    data: immediate
      ? {
        pauseRequestedAt: now,
        pausedAt: now,
        executionState: "PAUSED",
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.QUEUED,
        ),
        status: "pending",
        statusNormalized: normalizeEditHistoryStatus("pending"),
      }
      : {
        pauseRequestedAt: now,
      },
  });
  return { id: historyId, paused: immediate, mode: immediate ? "PAUSED" : "PAUSE_AFTER_CURRENT_BATCH" };
}

export async function resumeEditOperation({ shop, historyId, subscription }) {
  assertPremiumPlan(subscription);
  const history = await prisma.editHistory.findFirst({ where: { id: historyId, shop } });
  if (!history) throw new Error("Edit history not found");
  if (normalizeToLifecycleState(history.executionState) !== "PAUSED") {
    throw new Error("Only paused operations can be resumed.");
  }
  const resumedAt = new Date();
  await prisma.editHistory.updateMany({
    where: { id: historyId, shop },
    data: {
      pauseRequestedAt: null,
      resumedAt,
      executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.QUEUED,
      ),
      status: "pending",
      statusNormalized: normalizeEditHistoryStatus("pending"),
    },
  });
  await addbulkEditJob({
    historyId,
    shop,
    source: "manual_resume",
    executionId: history.executionIdentity || historyId,
  });
  return { id: historyId, resumed: true };
}

export async function requestPauseExportOperation({ shop, exportJobId, subscription }) {
  assertPremiumPlan(subscription);
  const job = await prisma.exportJob.findFirst({ where: { id: exportJobId, shop } });
  if (!job) throw new Error("Export job not found");
  const state = normalizeToLifecycleState(job.executionState);
  const now = new Date();
  if ([EXPORT_EXECUTION_STATES.COMPLETED, EXPORT_EXECUTION_STATES.CANCELLED, EXPORT_EXECUTION_STATES.FAILED].includes(state)) {
    throw new Error("Cannot pause a completed/cancelled/failed export.");
  }
  const immediate = [
    OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
    OPERATION_LIFECYCLE_STATES.QUEUED,
    OPERATION_LIFECYCLE_STATES.PLANNING,
    OPERATION_LIFECYCLE_STATES.PLANNED,
  ].includes(state);
  await prisma.exportJob.updateMany({
    where: { id: exportJobId, shop },
    data: immediate
      ? {
        pauseRequestedAt: now,
        pausedAt: now,
        executionState: "PAUSED",
        executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
        status: "PENDING",
        statusNormalized: normalizeExportJobStatus("PENDING"),
      }
      : {
        pauseRequestedAt: now,
      },
  });
  return { id: exportJobId, paused: immediate, mode: immediate ? "PAUSED" : "PAUSE_AFTER_CURRENT_BATCH" };
}

export async function resumeExportOperation({ shop, exportJobId, subscription }) {
  assertPremiumPlan(subscription);
  const job = await prisma.exportJob.findFirst({ where: { id: exportJobId, shop } });
  if (!job) throw new Error("Export job not found");
  if (normalizeToLifecycleState(job.executionState) !== "PAUSED") {
    throw new Error("Only paused exports can be resumed.");
  }
  const resumedAt = new Date();
  await prisma.exportJob.updateMany({
    where: { id: exportJobId, shop },
    data: {
      pauseRequestedAt: null,
      resumedAt,
      executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
      status: "PENDING",
      statusNormalized: normalizeExportJobStatus("PENDING"),
    },
  });
  await addbulkExportJob({
    exportJobId,
    shop,
    fields: job.fields,
    source: "manual_resume",
    executionId: exportJobId,
  });
  return { id: exportJobId, resumed: true };
}
