import { prisma } from "../config/database.js";
import { guardedEditHistoryUpdate } from "../services/operationTransitionGuards.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../services/operationLifecycleStateMachine.js";
import {
  decodeSnapshotItemCursor,
  encodeSnapshotItemCursor,
  validateSnapshotCursorScope,
  buildAfterCursorPredicate,
  findFrozenSnapshotBoundary,
} from "./targetSnapshotSetRepository.js";

export { findFrozenSnapshotBoundary };

const MAX_FAILURE_STAGE_LENGTH = 100;
const MAX_FAILURE_CODE_LENGTH = 100;
const MAX_FAILURE_MESSAGE_LENGTH = 2_000;

function buildRepositoryError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export function normalizeFenceToken(value) {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw buildRepositoryError("INVALID_FENCE_TOKEN");
    }

    return value;
  }

  if (
    typeof value === "string" &&
    /^[0-9]+$/.test(value)
  ) {
    return BigInt(value);
  }

  throw buildRepositoryError("INVALID_FENCE_TOKEN");
}

export function serializeFenceToken(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return String(value);
}

export function normalizePlainJsonObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw buildRepositoryError("INVALID_BATCH_PATCH");
  }

  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw buildRepositoryError("INVALID_BATCH_PATCH");
  }

  return value;
}

export function normalizeFailureText(value, fallback, maximumLength) {
  return String(value || fallback)
    .trim()
    .slice(0, maximumLength);
}

export function validateTransitionInputs({
  historyId,
  shop,
  expectedExecutionStates,
  expectedStateVersion,
  nextExecutionState,
}) {
  if (typeof historyId !== "string" || !historyId.trim()) {
    throw buildRepositoryError("INVALID_HISTORY_ID");
  }

  if (typeof shop !== "string" || !shop.trim()) {
    throw buildRepositoryError("INVALID_SHOP");
  }

  if (
    !Array.isArray(expectedExecutionStates) ||
    expectedExecutionStates.length === 0
  ) {
    throw buildRepositoryError("EXPECTED_EXECUTION_STATE_REQUIRED");
  }

  if (
    !Number.isSafeInteger(expectedStateVersion) ||
    expectedStateVersion < 0
  ) {
    throw buildRepositoryError("EXPECTED_STATE_VERSION_REQUIRED");
  }

  if (typeof nextExecutionState !== "string" || !nextExecutionState.trim()) {
    throw buildRepositoryError("NEXT_EXECUTION_STATE_REQUIRED");
  }
}

function buildTransitionSupplementalData({
  startedAt,
  completedAt,
  processedCount,
  shopifyBulkOperationId,
} = {}) {
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(processedCount !== undefined ? { processedCount } : {}),
    ...(shopifyBulkOperationId !== undefined
      ? { shopifyBulkOperationId }
      : {}),
  };
}

export async function findExecutionContext({
  historyId,
  shop,
  tx = prisma,
}) {
  const client = tx && typeof tx === "object" ? tx : prisma;
  const row = await client.editHistory.findFirst({
    where: {
      id: historyId,
      shop,
    },
    select: {
      id: true,
      shop: true,
      stateVersion: true,
      statusNormalized: true,
      executionStateNormalized: true,
      executionIdentity: true,
      snapshotSetId: true,
      snapshotSetRevision: true,
      cancelRequestedAt: true,
      targetSnapshotCount: true,
      targetProductMirrorBatchId: true,
      processedCount: true,
      totalItems: true,
      executeLeaseFencingToken: true,
      executeLeaseOwner: true,
      executeLeaseExpiresAt: true,
      shopifyBulkOperationId: true,
      batch: true,
    },
  });
  if (!row) return null;
  return {
    ...row,
    executeLeaseFencingTokenStr: serializeFenceToken(row.executeLeaseFencingToken),
  };
}

export async function findExecutionHistory(historyId, shop, tx = prisma) {
  return findExecutionContext({ historyId, shop, tx });
}

export async function findHistoryBatch(historyId, shop, tx = prisma) {
  const client = tx && typeof tx === "object" ? tx : prisma;
  const row = await client.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      batch: true,
      stateVersion: true,
      executeLeaseFencingToken: true,
      cancelRequestedAt: true,
      snapshotSetId: true,
      snapshotSetRevision: true,
      targetProductMirrorBatchId: true,
      shopifyBulkOperationId: true,
    },
  });
  if (!row) return null;
  return {
    ...row,
    executeLeaseFencingTokenStr: serializeFenceToken(row.executeLeaseFencingToken),
  };
}

export async function countRemainingSnapshotItems({
  shop,
  snapshotSetId,
  snapshotRevision = 1,
  cursorValue = null,
  cursorTargetKey = null,
  tx = prisma,
}) {
  const rawCursor = cursorValue || cursorTargetKey || null;
  const cursor = decodeSnapshotItemCursor(rawCursor);
  if (cursor && cursor.shop && cursor.snapshotSetId) {
    validateSnapshotCursorScope(cursor, { shop, snapshotSetId, snapshotRevision });
  }
  const cursorPredicate = buildAfterCursorPredicate(cursor);
  return tx.targetSnapshotItem.count({
    where: {
      shop,
      snapshotSetId,
      snapshotRevision,
      ...cursorPredicate,
    },
  });
}

export async function findMaxSnapshotTargetKey({ snapshotSetId, shop }) {
  const row = await prisma.targetSnapshotItem.findFirst({
    where: { shop, snapshotSetId },
    orderBy: [{ targetKey: "desc" }, { fieldPath: "desc" }],
    select: { targetKey: true, fieldPath: true },
  });
  return row ? encodeSnapshotItemCursor(row) : null;
}

export async function casTransitionExecutionState({
  historyId,
  shop,
  expectedExecutionStates,
  expectedStatuses,
  expectedStateVersion,
  expectedFenceToken,
  nextExecutionState,
  nextStatus = null,
  startedAt,
  completedAt,
  processedCount,
  shopifyBulkOperationId,
  tx = prisma,
}) {
  validateTransitionInputs({
    historyId,
    shop,
    expectedExecutionStates,
    expectedStateVersion,
    nextExecutionState,
  });

  const supplementalData =
    buildTransitionSupplementalData({
      startedAt,
      completedAt,
      processedCount,
      shopifyBulkOperationId,
    });

  return guardedEditHistoryUpdate({
    tx,
    id: historyId,
    shop,
    expectedExecutionStates,
    expectedStatuses:
      Array.isArray(expectedStatuses) &&
      expectedStatuses.length > 0
        ? expectedStatuses
        : undefined,
    expectedStateVersion,
    extraWhere:
      expectedFenceToken === undefined
        ? {}
        : {
            executeLeaseFencingToken:
              normalizeFenceToken(expectedFenceToken),
          },
    data: {
      ...supplementalData,
      executionState: nextExecutionState,
      executionStateNormalized:
        normalizeEditHistoryExecutionState(
          nextExecutionState,
        ),
      ...(nextStatus !== null
        ? {
            status: nextStatus,
            statusNormalized:
              normalizeEditHistoryStatus(nextStatus),
          }
        : {}),
    },
  });
}

export async function casBindSnapshotSet({
  historyId,
  shop,
  expectedStateVersion,
  snapshotSetId,
  snapshotSetRevision = 1,
  targetSnapshotCount,
  tx = prisma,
}) {
  if (typeof historyId !== "string" || !historyId.trim()) {
    throw buildRepositoryError("INVALID_HISTORY_ID");
  }
  if (typeof shop !== "string" || !shop.trim()) {
    throw buildRepositoryError("INVALID_SHOP");
  }
  if (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0) {
    throw buildRepositoryError("EXPECTED_STATE_VERSION_REQUIRED");
  }
  if (typeof snapshotSetId !== "string" || !snapshotSetId.trim()) {
    throw buildRepositoryError("INVALID_SNAPSHOT_SET_ID");
  }

  return guardedEditHistoryUpdate({
    tx,
    id: historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    ],
    expectedStateVersion,
    extraWhere: {
      snapshotSetId: null,
    },
    data: {
      snapshotSetId,
      snapshotSetRevision: Number(snapshotSetRevision || 1),
      ...(targetSnapshotCount !== undefined ? { targetSnapshotCount: Number(targetSnapshotCount) } : {}),
    },
  });
}

export async function casQueuePlannedExecution({
  historyId,
  shop,
  expectedStateVersion,
  replacementBatch,
  startedAt,
  completedAt,
  processedCount,
  shopifyBulkOperationId,
  tx = prisma,
}) {
  const expectedExecutionStates = [
    OPERATION_LIFECYCLE_STATES.PLANNED,
    OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
  ];
  const nextExecutionState = OPERATION_LIFECYCLE_STATES.QUEUED;

  validateTransitionInputs({
    historyId,
    shop,
    expectedExecutionStates,
    expectedStateVersion,
    nextExecutionState,
  });

  if (replacementBatch !== undefined) {
    normalizePlainJsonObject(replacementBatch);
  }

  const supplementalData = buildTransitionSupplementalData({
    startedAt,
    completedAt,
    processedCount,
    shopifyBulkOperationId,
  });

  return guardedEditHistoryUpdate({
    tx,
    id: historyId,
    shop,
    expectedExecutionStates,
    expectedStateVersion,
    data: {
      ...supplementalData,
      ...(replacementBatch !== undefined ? { batch: replacementBatch } : {}),
      executionState: nextExecutionState,
      executionStateNormalized:
        normalizeEditHistoryExecutionState(nextExecutionState),
      status: "queued",
      statusNormalized: normalizeEditHistoryStatus("queued"),
    },
  });
}

export async function casRequestExecutionCancellation({
  historyId,
  shop,
  expectedStateVersion,
  cancelReason,
  replacementBatch,
  tx = prisma,
}) {
  const expectedExecutionStates = [
    OPERATION_LIFECYCLE_STATES.PLANNED,
    OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
    OPERATION_LIFECYCLE_STATES.QUEUED,
    OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
  ];
  const nextExecutionState = OPERATION_LIFECYCLE_STATES.CANCELLED;

  validateTransitionInputs({
    historyId,
    shop,
    expectedExecutionStates,
    expectedStateVersion,
    nextExecutionState,
  });

  if (replacementBatch !== undefined) {
    normalizePlainJsonObject(replacementBatch);
  }

  const now = new Date();

  return guardedEditHistoryUpdate({
    tx,
    id: historyId,
    shop,
    expectedExecutionStates,
    expectedStateVersion,
    data: {
      status: "cancelled",
      statusNormalized: normalizeEditHistoryStatus("cancelled"),
      executionState: nextExecutionState,
      executionStateNormalized:
        normalizeEditHistoryExecutionState(nextExecutionState),
      cancelRequestedAt: now,
      cancelledAt: now,
      cancelReason: cancelReason || "USER_REQUESTED",
      completedAt: now,
      ...(replacementBatch !== undefined ? { batch: replacementBatch } : {}),
    },
  });
}

export async function casMarkPreExecutionFailed({
  historyId,
  shop,
  expectedStateVersion,
  failureStage,
  failureCode,
  failureMessage,
  retryable = false,
  replacementBatch,
  tx = prisma,
}) {
  const expectedExecutionStates = [
    OPERATION_LIFECYCLE_STATES.PLANNED,
    OPERATION_LIFECYCLE_STATES.QUEUED,
    OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
    OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
  ];
  const nextExecutionState = OPERATION_LIFECYCLE_STATES.FAILED;

  validateTransitionInputs({
    historyId,
    shop,
    expectedExecutionStates,
    expectedStateVersion,
    nextExecutionState,
  });

  if (replacementBatch !== undefined) {
    normalizePlainJsonObject(replacementBatch);
  }

  const normStage = normalizeFailureText(failureStage, "PRE_EXECUTION", MAX_FAILURE_STAGE_LENGTH);
  const normCode = failureCode ? normalizeFailureText(failureCode, "PRE_EXECUTION_FAILED", MAX_FAILURE_CODE_LENGTH) : "PRE_EXECUTION_FAILED";
  const normMsg = normalizeFailureText(failureMessage, "Pre-execution failed", MAX_FAILURE_MESSAGE_LENGTH);
  const failedAt = new Date();

  const executeTx = async (dbTx) => {
    const transition = await guardedEditHistoryUpdate({
      tx: dbTx,
      id: historyId,
      shop,
      expectedExecutionStates,
      expectedStateVersion,
      data: {
        status: "failed",
        statusNormalized: normalizeEditHistoryStatus("failed"),
        executionState: nextExecutionState,
        executionStateNormalized:
          normalizeEditHistoryExecutionState(nextExecutionState),
        failureStage: normStage,
        failureCode: normCode,
        latestErrorMessage: normMsg,
        latestErrorAt: failedAt,
        completedAt: failedAt,
        ...(replacementBatch !== undefined ? { batch: replacementBatch } : {}),
      },
    });

    if (!transition || !transition.success) {
      return transition;
    }

    await dbTx.editHistoryFailureAttempt.create({
      data: {
        shop,
        historyId,
        stateVersion: expectedStateVersion,
        fenceToken: null,
        stage: normStage,
        code: normCode,
        message: normMsg,
        retryable: Boolean(retryable),
      },
    });

    return transition;
  };

  if (tx && tx.$transaction === undefined) {
    return executeTx(tx);
  }

  return prisma.$transaction(executeTx);
}

export async function casMarkClaimedExecutionFailed({
  historyId,
  shop,
  expectedStateVersion,
  expectedFenceToken,
  failureStage,
  failureCode,
  failureMessage,
  retryable = false,
  replacementBatch,
  tx = prisma,
}) {
  const expectedExecutionStates = [
    OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
    OPERATION_LIFECYCLE_STATES.EXECUTING,
    OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
    OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
    OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
  ];
  const nextExecutionState = OPERATION_LIFECYCLE_STATES.FAILED;

  validateTransitionInputs({
    historyId,
    shop,
    expectedExecutionStates,
    expectedStateVersion,
    nextExecutionState,
  });

  if (expectedFenceToken === null || expectedFenceToken === undefined) {
    throw buildRepositoryError("REQUIRED_FENCE_TOKEN_MISSING");
  }

  const fenceToken = normalizeFenceToken(expectedFenceToken);
  const normStage = normalizeFailureText(failureStage, "BULK_EDIT_EXECUTE_WORKER", MAX_FAILURE_STAGE_LENGTH);
  const normCode = failureCode ? normalizeFailureText(failureCode, "EXECUTION_FAILED", MAX_FAILURE_CODE_LENGTH) : "EXECUTION_FAILED";
  const normMsg = normalizeFailureText(failureMessage, "Execution failed", MAX_FAILURE_MESSAGE_LENGTH);
  const failedAt = new Date();

  if (replacementBatch !== undefined) {
    normalizePlainJsonObject(replacementBatch);
  }

  const executeTx = async (dbTx) => {
    const transition = await guardedEditHistoryUpdate({
      tx: dbTx,
      id: historyId,
      shop,
      expectedExecutionStates,
      expectedStateVersion,
      extraWhere: {
        cancelRequestedAt: null,
        executeLeaseFencingToken: fenceToken,
      },
      data: {
        status: "failed",
        statusNormalized: normalizeEditHistoryStatus("failed"),
        executionState: nextExecutionState,
        executionStateNormalized:
          normalizeEditHistoryExecutionState(nextExecutionState),
        failureStage: normStage,
        failureCode: normCode,
        latestErrorMessage: normMsg,
        latestErrorAt: failedAt,
        completedAt: failedAt,
        ...(replacementBatch !== undefined ? { batch: replacementBatch } : {}),
      },
    });

    if (!transition || !transition.success) {
      return transition;
    }

    await dbTx.editHistoryFailureAttempt.create({
      data: {
        shop,
        historyId,
        stateVersion: expectedStateVersion,
        fenceToken,
        stage: normStage,
        code: normCode,
        message: normMsg,
        retryable: Boolean(retryable),
      },
    });

    return transition;
  };

  if (tx && tx.$transaction === undefined) {
    return executeTx(tx);
  }

  return prisma.$transaction(executeTx);
}

export async function casMarkFailedNonTerminal({
  historyId,
  shop,
  expectedStateVersion,
  expectedFenceToken = null,
  failureStage,
  failureCode,
  failureMessage,
  retryable = false,
  replacementBatch,
  tx = prisma,
}) {
  if (expectedFenceToken !== null && expectedFenceToken !== undefined) {
    return casMarkClaimedExecutionFailed({
      historyId,
      shop,
      expectedStateVersion,
      expectedFenceToken,
      failureStage,
      failureCode,
      failureMessage,
      retryable,
      replacementBatch,
      tx,
    });
  }

  return casMarkPreExecutionFailed({
    historyId,
    shop,
    expectedStateVersion,
    failureStage,
    failureCode,
    failureMessage,
    retryable,
    replacementBatch,
    tx,
  });
}
