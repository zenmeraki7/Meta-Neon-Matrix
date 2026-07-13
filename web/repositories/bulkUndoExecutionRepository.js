import crypto from "crypto";
import { prisma } from "../config/database.js";
import {
  BULK_UNDO_STATES,
  buildExecutionError,
  normalizeUndoState,
} from "../services/bulkEditExecutionStateService.js";

const CONFLICT_CHUNK_SIZE = 500;
const SUCCESSFUL_CHANGE_STATUSES = [
  "SUCCESS",
  "SUCCEEDED",
  "VERIFIED",
  "success",
  "succeeded",
  "verified",
];

async function updateHistoryWithUndoFence({
  historyId,
  shop,
  expectedExecutionId = null,
  allowedStates = [],
  buildData,
}) {
  const current = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { undo: true, updatedAt: true },
  });
  if (!current) return { count: 0 };

  const currentUndo = normalizeUndoState(current.undo);
  if (
    expectedExecutionId &&
    currentUndo.executionIdentity !== expectedExecutionId
  ) {
    return { count: 0 };
  }
  if (allowedStates.length && !allowedStates.includes(currentUndo.state)) {
    return { count: 0 };
  }

  return prisma.editHistory.updateMany({
    where: { id: historyId, shop, updatedAt: current.updatedAt },
    data: buildData(currentUndo),
  });
}

export async function persistUndoConflictChunks({
  shop,
  undoOperationId,
  safeProducts = [],
  conflicts = [],
}) {
  if (!undoOperationId) return;

  await prisma.undoOperationConflictChunk.deleteMany({
    where: { shop, undoOperationId },
  });

  const safeTargetIdentities = safeProducts
    .map((row) => row?.targetIdentity)
    .filter(Boolean);

  const safeChunks = [];
  for (let i = 0; i < safeTargetIdentities.length; i += CONFLICT_CHUNK_SIZE) {
    safeChunks.push({
      shop,
      undoOperationId,
      chunkType: "SAFE_IDENTITIES",
      chunkIndex: Math.floor(i / CONFLICT_CHUNK_SIZE),
      totalItems: safeTargetIdentities.length,
      payload: {
        targetIdentities: safeTargetIdentities.slice(
          i,
          i + CONFLICT_CHUNK_SIZE
        ),
      },
    });
  }

  const conflictChunks = [];
  for (let i = 0; i < conflicts.length; i += CONFLICT_CHUNK_SIZE) {
    conflictChunks.push({
      shop,
      undoOperationId,
      chunkType: "CONFLICTS",
      chunkIndex: Math.floor(i / CONFLICT_CHUNK_SIZE),
      totalItems: conflicts.length,
      payload: { conflicts: conflicts.slice(i, i + CONFLICT_CHUNK_SIZE) },
    });
  }

  const all = [...safeChunks, ...conflictChunks];
  if (!all.length) return;

  for (let i = 0; i < all.length; i += 250) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.undoOperationConflictChunk.createMany({
      data: all.slice(i, i + 250),
      skipDuplicates: true,
    });
  }
}

export async function claimUndoExecution({
  historyId,
  shop,
  executionId,
  jobId,
  attempt,
}) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      id: true,
      shop: true,
      batch: true,
      rules: true,
      undo: true,
      updatedAt: true,
    },
  });

  if (!history) {
    throw new Error(
      `EditHistory not found for shop ${shop} and id ${historyId}`
    );
  }

  const undo = normalizeUndoState(history.undo);
  if (undo.allowed !== true) {
    const error = new Error("This history is not eligible for undo");
    error.code = "UNDO_NOT_ALLOWED";
    throw error;
  }
  if (
    executionId &&
    undo.executionIdentity &&
    executionId !== undo.executionIdentity
  ) {
    throw new Error("Bulk undo execution identity mismatch");
  }

  if (
    [
      BULK_UNDO_STATES.AWAITING_SHOPIFY,
      BULK_UNDO_STATES.FINALIZING,
      BULK_UNDO_STATES.COMPLETED,
      BULK_UNDO_STATES.PARTIAL,
    ].includes(undo.state)
  ) {
    return null;
  }

  const updated = await prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      updatedAt: history.updatedAt,
    },
    data: {
      undo: {
        ...undo,
        status: "processing",
        state: BULK_UNDO_STATES.DISPATCHING,
        startedAt: undo.startedAt || new Date(),
        dispatchStartedAt: new Date(),
        dispatchJobId: jobId,
        dispatchAttempt: attempt,
      },
    },
  });

  return updated.count ? history : null;
}

export async function findUndoHistoryForExecution(historyId, shop) {
  return prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      id: true,
      batch: true,
      rules: true,
      undo: true,
      executionIdentity: true,
    },
  });
}

export async function findSuccessfulChangeRecords({
  historyId,
  shop,
  limit,
  cursorId = null,
}) {
  return prisma.changeRecord.findMany({
    where: {
      editHistoryId: historyId,
      shop,
      status: { in: SUCCESSFUL_CHANGE_STATUSES },
    },
    orderBy: { id: "asc" },
    take: limit,
    ...(cursorId
      ? {
          skip: 1,
          cursor: { id: cursorId },
        }
      : {}),
  });
}

export async function findUndoSnapshotRows({
  shop,
  snapshotSetId,
  targetKeys,
}) {
  return prisma.targetSnapshotItem.findMany({
    where: {
      shop,
      snapshotSetId,
      targetKey: { in: targetKeys },
      executionStatus: { in: ["SUCCEEDED", "VERIFIED"] },
      undoStatus: "PENDING",
    },
    select: {
      id: true,
      targetKey: true,
      productId: true,
      variantId: true,
      targetType: true,
      plannedMutation: true,
      beforeValues: true,
      undoPayload: true,
      executionStatus: true,
      shopifyResultId: true,
    },
  });
}

export async function persistUndoConflictReport({
  historyId,
  shop,
  undo,
  expectedExecutionId = null,
  conflictReport,
  undoOperationId,
  safeProductsCount,
  conflictsCount,
}) {
  await updateHistoryWithUndoFence({
    historyId,
    shop,
    expectedExecutionId,
    allowedStates: [
      BULK_UNDO_STATES.DISPATCHING,
      BULK_UNDO_STATES.QUEUED,
      BULK_UNDO_STATES.RETRYABLE_FAILURE,
    ],
    buildData: (currentUndo) => ({
      undo: {
        ...currentUndo,
        conflictReport,
        safeReplaySubset: null,
        conflictChunking: {
          chunkType: "UndoOperationConflictChunk",
          undoOperationId,
          chunkSize: CONFLICT_CHUNK_SIZE,
          safeTotal: safeProductsCount,
          conflictTotal: conflictsCount,
        },
      },
    }),
  });
}

export async function updateUndoOperationState({
  undoOperationId,
  shop,
  data,
}) {
  if (!undoOperationId) return;
  await prisma.undoOperation.updateMany({
    where: {
      id: undoOperationId,
      shop,
      status: {
        notIn: ["completed", "failed", "cancelled"],
      },
    },
    data,
  });
}

export async function recoverFailedUndoExecution({
  undoOperationId,
  shop,
  reason,
  actorType = "SYSTEM_RECOVERY",
}) {
  const recoveryReason = String(reason || "").trim();
  if (!recoveryReason) throw new Error("RECOVERY_REASON_REQUIRED");
  const recoveryId = crypto.randomUUID();

  return prisma.$transaction(
    async (tx) => {
      const operation = await tx.undoOperation.findFirst({
        where: { id: undoOperationId, shop },
        include: { command: true },
      });
      if (!operation) throw new Error("UNDO_EXECUTION_NOT_FOUND");
      if (
        operation.state !== "failed" ||
        operation.processedCount !== 0 ||
        operation.bulkOperationId
      ) {
        throw new Error("UNDO_RECOVERY_NOT_SAFE");
      }

      const history = await tx.editHistory.findFirst({
        where: { id: operation.sourceEditHistoryId, shop },
        select: { id: true, undo: true },
      });
      if (!history) throw new Error("UNDO_HISTORY_NOT_FOUND");
      const undo = normalizeUndoState(history.undo);
      if (undo.executionIdentity !== operation.executionIdentity) {
        throw new Error("UNDO_RECOVERY_EXECUTION_IDENTITY_MISMATCH");
      }

      const recovered = await tx.undoOperation.updateMany({
        where: {
          id: operation.id,
          shop,
          state: "failed",
          processedCount: 0,
          bulkOperationId: null,
        },
        data: {
          status: "pending",
          state: "queued",
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        },
      });
      if (recovered.count !== 1) throw new Error("UNDO_RECOVERY_CONFLICT");

      await tx.editHistory.update({
        where: { id: history.id },
        data: {
          undo: {
            ...undo,
            status: "pending",
            state: BULK_UNDO_STATES.QUEUED,
            error: null,
            startedAt: null,
            completedAt: null,
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          shop,
          aggregateType: "UNDO_EXECUTION",
          aggregateId: operation.id,
          eventType: "UNDO_REQUESTED",
          eventIdentity: `undo-recovery:${operation.id}:${recoveryId}`,
          payloadJson: {
            shop,
            historyId: operation.sourceEditHistoryId,
            undoExecutionId: operation.id,
            executionId: operation.executionIdentity,
            source: "manual_undo_recovery",
            recoveryId,
          },
          status: "PENDING",
        },
      });

      await tx.bulkEditRecoveryAudit.create({
        data: {
          shop,
          historyId: operation.sourceEditHistoryId,
          mode: "undo_requeue",
          reason: recoveryReason,
          actorType,
          result: "RECOVERED",
          metadata: {
            undoOperationId: operation.id,
            recoveryId,
            previousState: operation.state,
            processedCount: operation.processedCount,
          },
        },
      });

      return {
        recovered: true,
        recoveryId,
        undoOperationId: operation.id,
        historyId: operation.sourceEditHistoryId,
      };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function reopenFalseCompletedUndoExecution({
  undoOperationId,
  shop,
  reason,
  evidence,
  actorType = "SYSTEM_RECONCILIATION",
}) {
  const recoveryReason = String(reason || "").trim();
  if (!recoveryReason) throw new Error("RECOVERY_REASON_REQUIRED");
  if (!evidence?.bulkOperationId || !evidence?.verificationFailure) {
    throw new Error("FALSE_COMPLETION_EVIDENCE_REQUIRED");
  }
  const recoveryId = crypto.randomUUID();

  return prisma.$transaction(
    async (tx) => {
      const operation = await tx.undoOperation.findFirst({
        where: { id: undoOperationId, shop },
      });
      if (
        !operation ||
        operation.state !== "completed" ||
        operation.bulkOperationId
      ) {
        throw new Error("UNDO_FALSE_COMPLETION_REOPEN_NOT_SAFE");
      }
      const history = await tx.editHistory.findFirst({
        where: { id: operation.sourceEditHistoryId, shop },
        select: { id: true, undo: true },
      });
      if (!history) throw new Error("UNDO_HISTORY_NOT_FOUND");
      const undo = normalizeUndoState(history.undo);
      if (
        undo.undoOperationId !== operation.id ||
        undo.executionIdentity !== operation.executionIdentity ||
        undo.state !== BULK_UNDO_STATES.COMPLETED
      ) {
        throw new Error("UNDO_FALSE_COMPLETION_IDENTITY_MISMATCH");
      }

      const reopened = await tx.undoOperation.updateMany({
        where: {
          id: operation.id,
          shop,
          state: "completed",
          bulkOperationId: null,
        },
        data: {
          status: "pending",
          state: "queued",
          processedCount: 0,
          restoredCount: 0,
          failedCount: 0,
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        },
      });
      if (reopened.count !== 1)
        throw new Error("UNDO_FALSE_COMPLETION_CONFLICT");

      await tx.editHistory.update({
        where: { id: history.id },
        data: {
          undo: {
            ...undo,
            allowed: true,
            status: "pending",
            state: BULK_UNDO_STATES.QUEUED,
            processedCount: 0,
            bulkOperationId: null,
            lastChangeRecordId: null,
            error: null,
            startedAt: null,
            completedAt: null,
          },
        },
      });

      await tx.outboxEvent.create({
        data: {
          shop,
          aggregateType: "UNDO_EXECUTION",
          aggregateId: operation.id,
          eventType: "UNDO_REQUESTED",
          eventIdentity: `undo-false-completion-recovery:${operation.id}:${recoveryId}`,
          payloadJson: {
            shop,
            historyId: operation.sourceEditHistoryId,
            undoExecutionId: operation.id,
            executionId: operation.executionIdentity,
            source: "false_completion_recovery",
            recoveryId,
          },
          status: "PENDING",
        },
      });

      await tx.bulkEditRecoveryAudit.create({
        data: {
          shop,
          historyId: operation.sourceEditHistoryId,
          mode: "UNDO_FALSE_COMPLETION_REOPEN",
          reason: recoveryReason,
          actorType,
          result: "REQUEUED",
          metadata: {
            recoveryId,
            undoOperationId: operation.id,
            evidence,
          },
        },
      });
      return {
        recovered: true,
        recoveryId,
        undoOperationId: operation.id,
        historyId: operation.sourceEditHistoryId,
      };
    },
    { isolationLevel: "Serializable" }
  );
}

export async function moveUndoToAwaitingShopify({
  historyId,
  shop,
  undo,
  batch,
  expectedExecutionId = null,
  bulkOperationId,
  cursorId,
  lastProductId,
  count,
  limit,
  conflicts,
}) {
  return updateHistoryWithUndoFence({
    historyId,
    shop,
    expectedExecutionId,
    allowedStates: [
      BULK_UNDO_STATES.DISPATCHING,
      BULK_UNDO_STATES.QUEUED,
      BULK_UNDO_STATES.RETRYABLE_FAILURE,
    ],
    buildData: (currentUndo) => ({
      bulkOperationId,
      processingBatchId: `${undo.executionIdentity || historyId}:${
        cursorId || "start"
      }`,
      batch: {
        ...batch,
        hasMore: count === limit,
        currentBatchTargetCount: count,
      },
      undo: {
        ...currentUndo,
        status: "processing",
        state: BULK_UNDO_STATES.AWAITING_SHOPIFY,
        bulkOperationId,
        lastChangeRecordId: lastProductId,
        conflicts: conflicts.slice(0, 200),
      },
    }),
  });
}

export async function findUndoStateOnly(historyId, shop) {
  return prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { undo: true },
  });
}

export async function transitionUndoFailureOrRequeue({
  historyId,
  shop,
  undo,
  expectedExecutionId = null,
  error,
  attempt,
  source,
  executionId,
  retryable,
}) {
  return updateHistoryWithUndoFence({
    historyId,
    shop,
    expectedExecutionId,
    allowedStates: [
      BULK_UNDO_STATES.QUEUED,
      BULK_UNDO_STATES.DISPATCHING,
      BULK_UNDO_STATES.AWAITING_SHOPIFY,
      BULK_UNDO_STATES.RETRYABLE_FAILURE,
    ],
    buildData: (currentUndo) => ({
      undo: {
        ...currentUndo,
        ...(retryable
          ? {
              status: "pending",
              state: BULK_UNDO_STATES.QUEUED,
            }
          : {
              status: "failed",
              state: BULK_UNDO_STATES.FAILED,
              completedAt: new Date(),
              error: buildExecutionError({
                code: error.code || "bulk_undo_worker_failure",
                stage: "queue_execution",
                message: error.message,
                retryable: false,
                details: { attempt, source, executionId },
              }),
            }),
      },
    }),
  });
}
