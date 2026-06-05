import { db } from "../../repositories/repositoryDb.js";
import { addBulkEditExecuteJob } from "../../Jobs/Queues/bulkEditExecuteJob.js";
import crypto from "crypto";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";

const RETRY_ALLOWED_SOURCE_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.FAILED,
  OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
]);

export class BulkEditRetryService {
  constructor({
    shop,
    prismaClient = db,
    enqueueExecuteJob = addBulkEditExecuteJob,
    uuidFactory = () => crypto.randomUUID(),
  }) {
    this.shop = shop;
    this.db = prismaClient;
    this.enqueueExecuteJob = enqueueExecuteJob;
    this.uuidFactory = uuidFactory;
  }

  async retryFailedOnly({ historyId }) {
    const history = await this.db.editHistory.findFirst({
      where: { id: historyId, shop: this.shop },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
        executionState: true,
        batch: true,
      },
    });
    if (!history) {
      throw new Error("Edit history not found");
    }
    if (!RETRY_ALLOWED_SOURCE_STATES.has(String(history.executionState || "").toUpperCase())) {
      const error = new Error("RETRY_STATE_CONFLICT");
      error.code = "CONFLICT";
      throw error;
    }

    const failedRows = await this.db.changeRecord.findMany({
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
    const nextExecutionId = this.uuidFactory();

    const retryStateReset = await this.db.editHistory.updateMany({
      where: { id: historyId, shop: this.shop },
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
        executionIdentity: nextExecutionId,
        batch: {
          ...currentBatch,
          retryFailedOnly: true,
          retryAttemptedAt: new Date().toISOString(),
          retrySourceExecutionIdentity: history.executionIdentity || null,
          retryTargetIdentities,
          retryCursorIndex: 0,
          lastProductId: null,
          hasMore: retryTargetIdentities.length > 0,
        },
      },
    });
    if (Number(retryStateReset?.count || 0) !== 1) {
      throw new Error("RETRY_TENANT_UPDATE_CONFLICT");
    }

    await this.enqueueExecuteJob({
      historyId,
      shop: this.shop,
      source: "retry_failed_only",
      executionId: nextExecutionId,
    });

    return {
      historyId,
      executionId: nextExecutionId,
      retryTargetCount: retryTargetIdentities.length,
    };
  }
}
