import { prisma } from "../config/database.js";
import {
  EXPORT_EXECUTION_STATES,
  appendSerializedExportError,
  buildExportExecutionError,
  isTerminalExportExecutionState,
} from "../services/exportExecutionStateService.js";
import {
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
} from "../utils/normalizedStateUtils.js";

async function tryTransactionAdvisoryLock(db, lockKey) {
  const rows = await db.$queryRaw`
    SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
  `;
  return Boolean(rows?.[0]?.locked);
}

export async function claimExportJobExecution({ exportJobId, shop, executionId, jobId, attempt }) {
  return prisma.$transaction(async (tx) => {
    const locked = await tryTransactionAdvisoryLock(tx, `bulk-export:${shop}`);
    if (!locked) {
      return { state: "shop_busy", exportJob: null };
    }

    const currentJob = await tx.exportJob.findUnique({ where: { id: exportJobId } });
    if (!currentJob) throw new Error("Export job not found");
    if (currentJob.shop !== shop) throw new Error("Cross-shop export execution blocked");
    if (executionId && executionId !== currentJob.id) throw new Error("Export execution identity mismatch");

    const executionState = String(currentJob.executionStateNormalized || "").toLowerCase();
    if (
      isTerminalExportExecutionState(executionState)
      || ["COMPLETED", "FAILED", "CANCELLED"].includes(currentJob.executionStateNormalized || "")
      || ["COMPLETED", "FAILED", "CANCELLED"].includes(currentJob.statusNormalized || "")
    ) {
      return { state: "terminal", exportJob: currentJob };
    }
    if (String(currentJob.executionState || "").toUpperCase() === "PAUSED") {
      return { state: "paused", exportJob: currentJob };
    }
    if (String(currentJob.executionState || "").toUpperCase() === "FINALIZING") {
      return { state: "finalizing", exportJob: currentJob };
    }
    if (
      currentJob.executionStateNormalized === normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING)
      && currentJob.fileUrl
    ) {
      return { state: "uploaded_pending_finalize", exportJob: currentJob };
    }

    const activeExport = await tx.exportJob.findFirst({
      where: {
        shop,
        statusNormalized: normalizeExportJobStatus("PROCESSING"),
        id: { not: exportJobId },
      },
      select: { id: true },
    });
    if (activeExport) {
      return { state: "shop_busy", exportJob: currentJob };
    }

    const isRecoverableSameJobRun =
      currentJob.statusNormalized === normalizeExportJobStatus("PROCESSING")
      && currentJob.executionStateNormalized === normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING)
      && !currentJob.fileUrl;

    const updated = await tx.exportJob.updateMany({
      where: {
        id: exportJobId,
        shop,
        statusNormalized: {
          in: [
            normalizeExportJobStatus("PENDING"),
            normalizeExportJobStatus("FAILED"),
            ...(isRecoverableSameJobRun ? [normalizeExportJobStatus("PROCESSING")] : []),
          ],
        },
        executionStateNormalized: {
          in: [
            normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
            normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
            normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.FAILED),
            ...(isRecoverableSameJobRun
              ? [normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING)]
              : []),
          ],
        },
        fileUrl: null,
      },
      data: {
        status: "PROCESSING",
        statusNormalized: normalizeExportJobStatus("PROCESSING"),
        executionState: EXPORT_EXECUTION_STATES.RUNNING,
        executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
        startedAt: currentJob.startedAt || new Date(),
        error: null,
        failureStage: null,
      },
    });

    if (updated.count !== 1) {
      return { state: "not_claimed", exportJob: currentJob };
    }

    const claimedJob = await tx.exportJob.update({
      where: { id: exportJobId },
      data: { error: null, startedAt: currentJob.startedAt || new Date() },
    });

    return {
      state: "claimed",
      exportJob: {
        ...claimedJob,
        dispatchJobId: jobId,
        dispatchAttempt: attempt,
      },
    };
  });
}

export async function loadExportJobErrorState(exportJobId, shop) {
  return prisma.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: { error: true },
  });
}

export async function markExportRetryableState({ exportJobId, shop, error, attempt, details = {} }) {
  const exportJob = await loadExportJobErrorState(exportJobId, shop);
  if (!exportJob) return;

  await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      ...(details?.executionId ? { id: String(details.executionId) } : {}),
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
      fileUrl: null,
    },
    data: {
      status: "PENDING",
      statusNormalized: normalizeExportJobStatus("PENDING"),
      executionState: EXPORT_EXECUTION_STATES.QUEUED,
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
      failureStage: error.code || "retryable",
      error: appendSerializedExportError(
        exportJob.error,
        buildExportExecutionError({
          code: error.code || "retryable_export",
          stage: "worker_execution",
          message: error.message,
          retryable: true,
          details: { attempt, ...details },
        }),
      ),
    },
  });
}

export async function markExportFailureState({ exportJobId, shop, error, attempt, source, executionId }) {
  const exportJob = await loadExportJobErrorState(exportJobId, shop);

  await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      ...(executionId ? { id: String(executionId) } : {}),
      executionStateNormalized: {
        in: [
          normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
        ],
      },
    },
    data: {
      status: "FAILED",
      statusNormalized: normalizeExportJobStatus("FAILED"),
      executionState: EXPORT_EXECUTION_STATES.FAILED,
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.FAILED),
      failureStage: error.code || "export_worker",
      error: appendSerializedExportError(
        exportJob?.error,
        buildExportExecutionError({
          code: error.code || "bulk_export_worker_failure",
          stage: "export_worker",
          message: error.message,
          retryable: false,
          details: {
            stack: error.stack || null,
            attempt,
            source,
            executionId,
          },
        }),
      ),
      completedAt: new Date(),
    },
  });
}

export async function markExportFinalizing(exportJobId, shop, executionId = null) {
  const updated = await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      ...(executionId ? { id: String(executionId) } : {}),
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
    },
    data: {
      executionState: EXPORT_EXECUTION_STATES.RUNNING,
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
    },
  });

  return updated.count === 1;
}

export async function finalizeExportSuccessState(exportJob, fileUrl, totalRows, executionId = null) {
  const now = new Date();
  const updated = await prisma.exportJob.updateMany({
    where: {
      id: exportJob.id,
      shop: exportJob.shop,
      ...(executionId ? { id: String(executionId) } : {}),
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: {
        in: [
          normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
        ],
      },
    },
    data: {
      executionState: EXPORT_EXECUTION_STATES.COMPLETED,
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.COMPLETED),
      status: "COMPLETED",
      statusNormalized: normalizeExportJobStatus("COMPLETED"),
      fileUrl,
      totalItems: totalRows,
      executionCursorOrdinal: null,
      durationMs: exportJob.startedAt
        ? Math.max(now.getTime() - new Date(exportJob.startedAt).getTime(), 0)
        : null,
      completedAt: now,
      failureStage: null,
    },
  });

  return updated.count === 1;
}

export async function findExportOperationState(exportJobId, shop) {
  return prisma.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: { cancelRequestedAt: true, pauseRequestedAt: true },
  });
}

export async function markExportCancelled(exportJobId, shop, executionId = null) {
  await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      ...(executionId ? { id: String(executionId) } : {}),
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
    },
    data: {
      status: "CANCELLED",
      statusNormalized: normalizeExportJobStatus("CANCELLED"),
      executionState: EXPORT_EXECUTION_STATES.CANCELLED,
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.CANCELLED),
      cancelledAt: new Date(),
      completedAt: new Date(),
    },
  });
}

export async function markExportPaused({ exportJobId, shop, cursorOrdinal, executionId = null }) {
  await prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      ...(executionId ? { id: String(executionId) } : {}),
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
    },
    data: {
      status: "PENDING",
      statusNormalized: normalizeExportJobStatus("PENDING"),
      executionState: "PAUSED",
      executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
      pausedAt: new Date(),
      executionCursorOrdinal: cursorOrdinal,
    },
  });
}

export async function findProductsForExport({ shop, productIds, mirrorBatchId }) {
  return prisma.product.findMany({
    where: {
      shop,
      id: { in: productIds },
      ...(mirrorBatchId ? { mirrorBatchId } : {}),
    },
    include: {
      variants: {
        orderBy: { id: "asc" },
      },
    },
  });
}

export async function checkpointExportCursor({ exportJobId, shop, cursorOrdinal, executionId = null }) {
  return prisma.exportJob.updateMany({
    where: {
      id: exportJobId,
      shop,
      ...(executionId ? { id: String(executionId) } : {}),
      statusNormalized: normalizeExportJobStatus("PROCESSING"),
      executionStateNormalized: {
        in: [
          normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.RUNNING),
        ],
      },
    },
    data: { executionCursorOrdinal: cursorOrdinal },
  });
}

export async function findExportTerminalFlags(exportJobId, shop) {
  return prisma.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: { statusNormalized: true, executionState: true },
  });
}
