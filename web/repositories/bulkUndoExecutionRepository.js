import { prisma } from "../config/database.js";
import {
  BULK_UNDO_STATES,
  buildExecutionError,
  normalizeUndoState,
} from "../services/bulkEditExecutionStateService.js";

const CONFLICT_CHUNK_SIZE = 500;

export async function persistUndoConflictChunks({
  shop,
  undoOperationId,
  safeProducts = [],
  conflicts = [],
}) {
  if (!undoOperationId) return;

  await prisma.undoOperationConflictChunk.deleteMany({ where: { shop, undoOperationId } });

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
      payload: { targetIdentities: safeTargetIdentities.slice(i, i + CONFLICT_CHUNK_SIZE) },
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

export async function claimUndoExecution({ historyId, shop, executionId, jobId, attempt }) {
  const history = await prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      id: true,
      shop: true,
      batch: true,
      rules: true,
      undo: true,
    },
  });

  if (!history) {
    throw new Error(`EditHistory not found for shop ${shop} and id ${historyId}`);
  }

  const undo = normalizeUndoState(history.undo);
  if (executionId && undo.executionIdentity && executionId !== undo.executionIdentity) {
    throw new Error("Bulk undo execution identity mismatch");
  }

  if ([
    BULK_UNDO_STATES.AWAITING_SHOPIFY,
    BULK_UNDO_STATES.AWAITING_CONFIRMATION,
    BULK_UNDO_STATES.RECONCILE_SUBMITTED,
    BULK_UNDO_STATES.FINALIZING,
    BULK_UNDO_STATES.COMPLETED,
    BULK_UNDO_STATES.PARTIAL,
  ].includes(undo.state)) {
    return null;
  }

  const updated = await prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      ...(executionId
        ? {
          undo: {
            path: ["executionIdentity"],
            equals: executionId,
          },
        }
        : {}),
      OR: [
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.QUEUED } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.RETRYABLE_FAILURE } },
      ],
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

export async function findSuccessfulChangeRecords({ historyId, shop, limit, cursorId = null }) {
  return prisma.changeRecord.findMany({
    where: {
      editHistoryId: historyId,
      shop,
      status: { in: ["SUCCESS", "VERIFIED"] },
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

export async function findUndoSnapshotRows({ shop, snapshotSetId, targetKeys }) {
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
  await prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      ...(expectedExecutionId
        ? {
          undo: {
            path: ["executionIdentity"],
            equals: expectedExecutionId,
          },
        }
        : {}),
      OR: [
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.DISPATCHING } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.QUEUED } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.RETRYABLE_FAILURE } },
      ],
    },
    data: {
      undo: {
        ...undo,
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
    },
  });
}

export async function updateUndoOperationState({ undoOperationId, shop, data }) {
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
  return prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      ...(expectedExecutionId
        ? {
          undo: {
            path: ["executionIdentity"],
            equals: expectedExecutionId,
          },
        }
        : {}),
      OR: [
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.DISPATCHING } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.QUEUED } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.RETRYABLE_FAILURE } },
      ],
    },
    data: {
      bulkOperationId,
      processingBatchId: `${undo.executionIdentity || historyId}:${cursorId || "start"}`,
      batch: {
        ...batch,
        lastProductId,
        hasMore: count === limit,
        currentBatchTargetCount: count,
      },
      undo: {
        ...undo,
        status: "processing",
        state: BULK_UNDO_STATES.AWAITING_SHOPIFY,
        bulkOperationId,
        conflicts: conflicts.slice(0, 200),
      },
    },
  });
}

export async function markUndoReconcileSubmitted({
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
}) {
  return prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      AND: [
        ...(expectedExecutionId
          ? [{ undo: { path: ["executionIdentity"], equals: expectedExecutionId } }]
          : []),
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.DISPATCHING } },
      ],
    },
    data: {
      bulkOperationId,
      processingBatchId: `${undo.executionIdentity || historyId}:${cursorId || "start"}`,
      batch: {
        ...batch,
        lastProductId,
        hasMore: count === limit,
        currentBatchTargetCount: count,
        reconcileReason: "SUBMITTED_BUT_LOCAL_TRANSITION_FAILED",
        reconcileAt: new Date().toISOString(),
      },
      undo: {
        ...undo,
        status: "processing",
        state: BULK_UNDO_STATES.RECONCILE_SUBMITTED,
        bulkOperationId,
      },
    },
  });
}

export async function moveUndoToAwaitingConfirmation({
  historyId,
  shop,
  undo,
  expectedExecutionId = null,
  conflictReport,
}) {
  return prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      AND: [
        ...(expectedExecutionId
          ? [{ undo: { path: ["executionIdentity"], equals: expectedExecutionId } }]
          : []),
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.DISPATCHING } },
      ],
    },
    data: {
      undo: {
        ...undo,
        status: "pending",
        state: BULK_UNDO_STATES.AWAITING_CONFIRMATION,
        conflictReport,
      },
    },
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
  return prisma.editHistory.updateMany({
    where: {
      id: historyId,
      shop,
      ...(expectedExecutionId
        ? {
          undo: {
            path: ["executionIdentity"],
            equals: expectedExecutionId,
          },
        }
        : {}),
      OR: [
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.QUEUED } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.DISPATCHING } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.AWAITING_SHOPIFY } },
        { undo: { path: ["state"], equals: BULK_UNDO_STATES.RETRYABLE_FAILURE } },
      ],
    },
    data: {
      undo: {
        ...undo,
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
    },
  });
}
