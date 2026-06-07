import { prisma } from "../config/database.js";
import { guardedEditHistoryUpdate } from "../services/operationTransitionGuards.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../services/operationLifecycleStateMachine.js";

export async function findExecutionHistory(historyId, shop) {
  return prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      id: true,
      shop: true,
      batch: true,
      rules: true,
      entitlementSnapshot: true,
      scheduledAt: true,
      targetMirrorBatchId: true,
      status: true,
      executionState: true,
      executionIdentity: true,
      snapshotSetId: true,
      cancelRequestedAt: true,
      targetSnapshotCount: true,
      processedCount: true,
      totalItems: true,
    },
  });
}

export async function findHistoryBatch(historyId, shop) {
  return prisma.editHistory.findFirst({
    where: { id: historyId, shop },
    select: { batch: true },
  });
}

export async function countRemainingSnapshotItems({ snapshotSetId, shop, cursorTargetKey }) {
  return prisma.targetSnapshotItem.count({
    where: {
      shop,
      snapshotSetId,
      ...(typeof cursorTargetKey === "string" && cursorTargetKey.trim()
        ? { targetKey: { gt: cursorTargetKey } }
        : {}),
    },
  });
}

export async function findMaxSnapshotTargetKey({ snapshotSetId, shop }) {
  const row = await prisma.targetSnapshotItem.findFirst({
    where: { shop, snapshotSetId },
    orderBy: [{ targetKey: "desc" }],
    select: { targetKey: true },
  });
  return String(row?.targetKey || "").trim() || null;
}

export async function casTransitionExecutionState({
  historyId,
  shop,
  expectedExecutionStates = [],
  expectedStatuses = [],
  expectedFenceToken = null,
  nextExecutionState,
  nextStatus = null,
  batchPatch = {},
  extraData = {},
}) {
  if (!historyId || !shop || !nextExecutionState) return null;
  return guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: expectedExecutionStates.length ? expectedExecutionStates : undefined,
    expectedStatuses: expectedStatuses.length ? expectedStatuses : undefined,
    extraWhere: expectedFenceToken === null
      ? {}
      : {
        batch: {
          path: ["executeLeaseFencingToken"],
          equals: Number(expectedFenceToken),
        },
      },
    data: {
      executionState: nextExecutionState,
      executionStateNormalized: normalizeEditHistoryExecutionState(nextExecutionState),
      ...(nextStatus
        ? {
          status: nextStatus,
          statusNormalized: normalizeEditHistoryStatus(nextStatus),
        }
        : {}),
      batch: batchPatch,
      ...extraData,
    },
  });
}

export async function casMarkFailedNonTerminal({
  historyId,
  shop,
  expectedFenceToken = null,
  failureStage,
  failureMessage,
  batchPatch = {},
}) {
  return guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: [
      OPERATION_LIFECYCLE_STATES.PLANNED,
      OPERATION_LIFECYCLE_STATES.QUEUED,
      OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
      OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
      OPERATION_LIFECYCLE_STATES.EXECUTING,
      OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED,
      OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING,
      OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
    ],
    extraWhere: expectedFenceToken === null
      ? {}
      : {
        batch: {
          path: ["executeLeaseFencingToken"],
          equals: Number(expectedFenceToken),
        },
      },
    data: {
      status: "failed",
      statusNormalized: normalizeEditHistoryStatus("failed"),
      executionState: OPERATION_LIFECYCLE_STATES.FAILED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.FAILED,
      ),
      failureStage,
      completedAt: new Date(),
      batch: batchPatch,
      failureMessage,
    },
  });
}
