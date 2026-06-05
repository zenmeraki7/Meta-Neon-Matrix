import { prisma } from "../config/database.js";
import { OPERATION_LIFECYCLE_STATES } from "../services/operationLifecycleStateMachine.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../utils/normalizedStateUtils.js";

export async function findPreviewContractRecord(previewContractId, shop) {
  return prisma.filterTrack.findFirst({
    where: {
      id: String(previewContractId),
      shop,
      type: "preview",
    },
  });
}

export async function createManualEditHistoryWithImmutableCommand({
  historyData,
  buildImmutableEditCommandForHistory,
}) {
  const shop = String(historyData?.shop || "").trim();
  if (!shop) {
    throw new Error("BULK_EDIT_COMMAND_REQUIRES_SHOP");
  }

  return prisma.$transaction(async (tx) => {
    const history = await tx.editHistory.create({
      data: {
        ...historyData,
        executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.QUEUED,
        ),
      },
    });

    const immutableEditCommand = buildImmutableEditCommandForHistory(history);

    const updated = await tx.editHistory.updateMany({
      where: { id: history.id, shop: history.shop },
      data: {
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          immutableEditCommand,
          targetSnapshotSet: {
            id: `EDIT_HISTORY:${history.id}`,
            ownerType: "EDIT_HISTORY",
            ownerId: history.id,
            sourceType: history.batch?.explicitProductIds?.length
              ? "MANUAL_SELECTION"
              : "FILTER",
            status: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
          },
        },
      },
    });
    if (Number(updated?.count || 0) !== 1) {
      throw new Error("BULK_EDIT_COMMAND_TENANT_UPDATE_CONFLICT");
    }

    return {
      historyId: history.id,
      historyShop: history.shop,
      executionIdentity: history.executionIdentity,
    };
  });
}

export async function markManualEditHistoryEnqueueFailed({
  historyId,
  shop,
  executionIdentity,
  errorMessage,
}) {
  const safeHistoryId = String(historyId || "").trim();
  const safeShop = String(shop || "").trim();
  if (!safeHistoryId || !safeShop) {
    throw new Error("BULK_EDIT_ENQUEUE_FAILURE_REQUIRES_HISTORY_AND_SHOP");
  }

  return prisma.$transaction(async (tx) => {
    const history = await tx.editHistory.findFirst({
      where: {
        id: safeHistoryId,
        shop: safeShop,
        ...(executionIdentity ? { executionIdentity } : {}),
      },
      select: {
        batch: true,
        executionState: true,
      },
    });
    if (!history) return { count: 0 };
    if (history.executionState !== OPERATION_LIFECYCLE_STATES.QUEUED) {
      return { count: 0 };
    }

    return tx.editHistory.updateMany({
      where: {
        id: safeHistoryId,
        shop: safeShop,
        ...(executionIdentity ? { executionIdentity } : {}),
        executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
      },
      data: {
        status: "failed",
        statusNormalized: normalizeEditHistoryStatus("failed"),
        executionState: OPERATION_LIFECYCLE_STATES.FAILED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.FAILED,
        ),
        batch: {
          ...(history.batch && typeof history.batch === "object" ? history.batch : {}),
          enqueueFailure: {
            failedAt: new Date().toISOString(),
            message: String(errorMessage || "Bulk edit queue enqueue failed"),
          },
        },
      },
    });
  });
}
