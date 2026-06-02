import { prisma } from "../config/database.js";
import { OPERATION_LIFECYCLE_STATES } from "../services/operationLifecycleStateMachine.js";
import { normalizeEditHistoryExecutionState } from "../utils/normalizedStateUtils.js";

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

    await tx.editHistory.update({
      where: { id: history.id },
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

    return {
      historyId: history.id,
      historyShop: history.shop,
      executionIdentity: history.executionIdentity,
    };
  });
}
