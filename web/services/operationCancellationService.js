import { db } from "../repositories/repositoryDb.js";
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

const idempotencyStore = new IdempotencyStoreService(db);

function normalizeCancelReason(reason) {
  if (typeof reason !== "string") return null;
  const value = reason.trim();
  return value.length ? value.slice(0, 500) : null;
}

function buildStage(executionStateRaw) {
  const state = String(executionStateRaw || "").toUpperCase();
  if (state === OPERATION_LIFECYCLE_STATES.TARGET_FREEZING) return "BEFORE_FREEZE";
  if (state === OPERATION_LIFECYCLE_STATES.TARGET_FROZEN || state === OPERATION_LIFECYCLE_STATES.QUEUED) return "AFTER_FREEZE_BEFORE_EXECUTION";
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

export async function requestEditHistoryCancellation({
  shop,
  historyId,
  reason,
  idempotencyKey,
}) {
  const idemKey = String(idempotencyKey || "").trim();
  if (!idemKey) {
    const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const begin = await idempotencyStore.begin({
    shop,
    scope: "EDIT_HISTORY_CANCEL",
    key: idemKey,
    requestHash: buildIdempotencyRequestHash({
      shop,
      historyId,
      reason: normalizeCancelReason(reason),
    }),
  });
  if (begin.mode === "replay") {
    return begin.response;
  }
  const leaseOwnerId = buildLeaseOwnerId("cancel-edit-history");
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
  const history = await db.editHistory.findFirst({
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
      executionState: OPERATION_LIFECYCLE_STATES.CANCELLED,
      executionStateNormalized: normalizeEditHistoryExecutionState("CANCELLED"),
      cancelledAt: now,
      completedAt: now,
    });
  } else if (stage === "AFTER_EXECUTION") {
    const error = new Error("Execution already completed. Cancellation is not allowed; use undo.");
    error.code = "CANCEL_NOT_ALLOWED_AFTER_EXECUTION";
    throw error;
  }

  await db.editHistory.updateMany({
    where: { id: history.id, shop },
    data: update,
  });
  const response = {
    id: history.id,
    stage,
    cancellation: stage === "DURING_VERIFICATION"
      ? "VERIFICATION_STOP_REQUESTED"
      : stage === "DURING_EXECUTION"
        ? "STOP_AFTER_CURRENT_BATCH"
        : "CANCELLED",
  };
  await idempotencyStore.complete({
    recordId: begin.recordId,
    shop,
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

export async function requestExportJobCancellation({
  shop,
  exportJobId,
  reason,
  idempotencyKey,
}) {
  const idemKey = String(idempotencyKey || "").trim();
  if (!idemKey) {
    const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const begin = await idempotencyStore.begin({
    shop,
    scope: "EXPORT_JOB_CANCEL",
    key: idemKey,
    requestHash: buildIdempotencyRequestHash({
      shop,
      operationType: "EXPORT_JOB_CANCEL",
      exportJobId,
      reason: normalizeCancelReason(reason),
    }),
  });
  if (begin.mode === "replay") {
    return begin.response;
  }
  const leaseOwnerId = buildLeaseOwnerId("cancel-export-job");
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
  const job = await db.exportJob.findFirst({
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

  await db.exportJob.updateMany({
    where: { id: job.id, shop },
    data: update,
  });

  const response = {
    id: job.id,
    stage,
    cancellation: stage === "DURING_VERIFICATION"
      ? "VERIFICATION_STOP_REQUESTED"
      : stage === "DURING_EXECUTION"
        ? "STOP_AFTER_CURRENT_BATCH"
        : "CANCELLED",
  };
  await idempotencyStore.complete({
    recordId: begin.recordId,
    shop,
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
