import { prisma } from "../config/database.js";
import { addBulkEditExecuteJob } from "../Jobs/Queues/bulkEditExecuteJob.js";
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
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  releaseOperationLease,
} from "./operationLeaseService.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "./idempotency/IdempotencyStoreService.js";

const idempotencyStore = new IdempotencyStoreService(prisma);

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

export async function requestPauseEditOperation({
  shop,
  historyId,
  subscription,
  idempotencyKey,
}) {
  assertPremiumPlan(subscription);
  const idemKey = String(idempotencyKey || "").trim();
  if (!idemKey) {
    const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const begin = await idempotencyStore.begin({
    shop,
    scope: "EDIT_HISTORY_PAUSE",
    key: idemKey,
    requestHash: buildIdempotencyRequestHash({ shop, historyId }),
  });
  if (begin.mode === "replay") return begin.response;
  const leaseOwnerId = buildLeaseOwnerId("pause-edit-history");
  const lease = await acquireOperationLease({
    shop,
    namespace: "EDIT_HISTORY_LIFECYCLE",
    resourceId: String(historyId),
    ownerId: leaseOwnerId,
  });
  if (!lease?.acquired) {
    const error = new Error("OPERATION_LEASE_CONFLICT");
    error.code = "CONFLICT";
    throw error;
  }
  try {
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
        executionState: OPERATION_LIFECYCLE_STATES.PAUSED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.PAUSED,
        ),
        status: "pending",
        statusNormalized: normalizeEditHistoryStatus("pending"),
      }
      : {
        pauseRequestedAt: now,
      },
  });
  const response = { id: historyId, paused: immediate, mode: immediate ? "PAUSED" : "PAUSE_AFTER_CURRENT_BATCH" };
  await idempotencyStore.complete({
    recordId: begin.recordId,
    response,
  });
  return response;
  } finally {
    await releaseOperationLease({
      shop,
      namespace: "EDIT_HISTORY_LIFECYCLE",
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    });
  }
}

export async function resumeEditOperation({
  shop,
  historyId,
  subscription,
  idempotencyKey,
}) {
  assertPremiumPlan(subscription);
  const idemKey = String(idempotencyKey || "").trim();
  if (!idemKey) {
    const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const begin = await idempotencyStore.begin({
    shop,
    scope: "EDIT_HISTORY_RESUME",
    key: idemKey,
    requestHash: buildIdempotencyRequestHash({ shop, historyId }),
  });
  if (begin.mode === "replay") return begin.response;
  const leaseOwnerId = buildLeaseOwnerId("resume-edit-history");
  const lease = await acquireOperationLease({
    shop,
    namespace: "EDIT_HISTORY_LIFECYCLE",
    resourceId: String(historyId),
    ownerId: leaseOwnerId,
  });
  if (!lease?.acquired) {
    const error = new Error("OPERATION_LEASE_CONFLICT");
    error.code = "CONFLICT";
    throw error;
  }
  try {
  const history = await prisma.editHistory.findFirst({ where: { id: historyId, shop } });
  if (!history) throw new Error("Edit history not found");
  if (normalizeToLifecycleState(history.executionState) !== OPERATION_LIFECYCLE_STATES.PAUSED) {
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
  await addBulkEditExecuteJob({
    historyId,
    shop,
    source: "manual_resume",
    executionId: history.executionIdentity || historyId,
  });
  const response = { id: historyId, resumed: true };
  await idempotencyStore.complete({
    recordId: begin.recordId,
    response,
  });
  return response;
  } finally {
    await releaseOperationLease({
      shop,
      namespace: "EDIT_HISTORY_LIFECYCLE",
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    });
  }
}

export async function requestPauseExportOperation({
  shop,
  exportJobId,
  subscription,
  idempotencyKey,
}) {
  assertPremiumPlan(subscription);
  const idemKey = String(idempotencyKey || "").trim();
  if (!idemKey) {
    const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const begin = await idempotencyStore.begin({
    shop,
    scope: "EXPORT_JOB_PAUSE",
    key: idemKey,
    requestHash: buildIdempotencyRequestHash({
      shop,
      operationType: "EXPORT_JOB_PAUSE",
      exportJobId,
    }),
  });
  if (begin.mode === "replay") return begin.response;
  const leaseOwnerId = buildLeaseOwnerId("pause-export-job");
  const lease = await acquireOperationLease({
    shop,
    namespace: "EXPORT_JOB_LIFECYCLE",
    resourceId: String(exportJobId),
    ownerId: leaseOwnerId,
  });
  if (!lease?.acquired) {
    const error = new Error("OPERATION_LEASE_CONFLICT");
    error.code = "CONFLICT";
    throw error;
  }
  try {
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
  const response = { id: exportJobId, paused: immediate, mode: immediate ? "PAUSED" : "PAUSE_AFTER_CURRENT_BATCH" };
  await idempotencyStore.complete({
    recordId: begin.recordId,
    response,
  });
  return response;
  } finally {
    await releaseOperationLease({
      shop,
      namespace: "EXPORT_JOB_LIFECYCLE",
      resourceId: String(exportJobId),
      ownerId: leaseOwnerId,
    });
  }
}

export async function resumeExportOperation({
  shop,
  exportJobId,
  subscription,
  idempotencyKey,
}) {
  assertPremiumPlan(subscription);
  const idemKey = String(idempotencyKey || "").trim();
  if (!idemKey) {
    const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const begin = await idempotencyStore.begin({
    shop,
    scope: "EXPORT_JOB_RESUME",
    key: idemKey,
    requestHash: buildIdempotencyRequestHash({
      shop,
      operationType: "EXPORT_JOB_RESUME",
      exportJobId,
    }),
  });
  if (begin.mode === "replay") return begin.response;
  const leaseOwnerId = buildLeaseOwnerId("resume-export-job");
  const lease = await acquireOperationLease({
    shop,
    namespace: "EXPORT_JOB_LIFECYCLE",
    resourceId: String(exportJobId),
    ownerId: leaseOwnerId,
  });
  if (!lease?.acquired) {
    const error = new Error("OPERATION_LEASE_CONFLICT");
    error.code = "CONFLICT";
    throw error;
  }
  try {
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
  const response = { id: exportJobId, resumed: true };
  await idempotencyStore.complete({
    recordId: begin.recordId,
    response,
  });
  return response;
  } finally {
    await releaseOperationLease({
      shop,
      namespace: "EXPORT_JOB_LIFECYCLE",
      resourceId: String(exportJobId),
      ownerId: leaseOwnerId,
    });
  }
}
