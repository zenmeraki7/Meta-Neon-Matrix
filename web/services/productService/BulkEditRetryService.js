import { prisma } from "../../config/database.js";
import { addbulkEditJob } from "../../Jobs/Queues/bulkEditJob.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";

export class BulkEditRetryService {
  constructor({ shop }) {
    this.shop = shop;
  }

  async retryFailedOnly({ historyId }) {
    const history = await prisma.editHistory.findFirst({
      where: { id: historyId, shop: this.shop },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
        batch: true,
      },
    });
    if (!history) {
      throw new Error("Edit history not found");
    }

    const failedRows = await prisma.changeRecord.findMany({
      where: {
        editHistoryId: historyId,
        shop: this.shop,
        status: "FAILED",
      },
      select: { targetIdentity: true },
      distinct: ["targetIdentity"],
    });

    const retryTargetIdentities = failedRows
      .map((row) => row.targetIdentity)
      .filter(Boolean);
    if (!retryTargetIdentities.length) {
      throw new Error("No failed targets found to retry.");
    }

    const currentBatch = history.batch && typeof history.batch === "object" ? history.batch : {};

    await prisma.editHistory.update({
      where: { id: historyId },
      data: {
        status: "pending",
        statusNormalized: normalizeEditHistoryStatus("pending"),
        executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.QUEUED,
        ),
        failureStage: null,
        completedAt: null,
        cancelledAt: null,
        cancelRequestedAt: null,
        pauseRequestedAt: null,
        resumedAt: new Date(),
        batch: {
          ...currentBatch,
          retryFailedOnly: true,
          retryTargetIdentities,
          retryCursorIndex: 0,
          lastProductId: null,
          hasMore: retryTargetIdentities.length > 0,
        },
      },
    });

    await addbulkEditJob({
      historyId,
      shop: this.shop,
      source: "retry_failed_only",
      executionId: history.executionIdentity || historyId,
    });

    return {
      historyId,
      retryTargetCount: retryTargetIdentities.length,
    };
  }
}

