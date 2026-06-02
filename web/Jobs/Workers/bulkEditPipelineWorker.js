import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import ProductBulkService from "../../services/productService/productBulkEditService.js";
import {
  enqueueBulkEditExecuteStageJob,
  enqueueBulkEditMutationPlanJob,
} from "../Queues/bulkEditPipelineJob.js";
import { addBulkEditExecuteJob } from "../Queues/bulkEditExecuteJob.js";
import { normalizeEditHistoryExecutionState } from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { assertValidOperationKey } from "../../services/bulkEdit/planner/productEditOperationRegistry.js";
import {
  beginEditHistoryStage,
  completeEditHistoryStage,
  failEditHistoryStage,
} from "../../services/operationStageIdempotencyService.js";
import {
  acquireOperationLease,
  assertOperationLeaseOwnership,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";
import { guardedEditHistoryUpdate } from "../../services/operationTransitionGuards.js";

function assertPipelineExecutionState(history, allowedStates = []) {
  const state = String(history?.executionState || "").toUpperCase();
  if (!allowedStates.includes(state)) {
    throw new Error(`PIPELINE_STATE_CONFLICT:${state}`);
  }
}

const QUEUE_NAME = process.env.BULK_EDIT_PIPELINE_QUEUE || "bulk-edit-pipeline";

async function processTargetFreeze(jobData) {
  const { historyId, shop, executionId } = jobData;
  const stageRun = await beginEditHistoryStage({
    historyId,
    shop,
    stage: "targetFreeze",
    executionId,
  });
  if (stageRun.state === "completed" || stageRun.state === "running") {
    return;
  }
  const history = await db.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      cancelRequestedAt: true,
      executionIdentity: true,
      executionState: true,
    },
  });
  if (!history) {
    throw new Error("Edit history not found for target.freeze stage");
  }
  if (history.cancelRequestedAt) {
    throw new Error("OPERATION_CANCEL_REQUESTED");
  }
  if (history.executionIdentity && executionId && history.executionIdentity !== executionId) {
    throw new Error("STALE_EXECUTION_JOB");
  }
  assertPipelineExecutionState(history, [
    OPERATION_LIFECYCLE_STATES.QUEUED,
    OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
    OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
  ]);

  const leaseOwnerId = buildLeaseOwnerId("bulk-edit-target-freeze");
  const lease = await acquireOperationLease({
    shop,
    namespace: "TARGET_FREEZE",
    resourceId: String(historyId),
    ownerId: leaseOwnerId,
  });
  if (!lease?.acquired) {
    throw new Error("TARGET_FREEZE_LEASE_CONFLICT");
  }
  const leaseHeartbeat = setInterval(() => {
    heartbeatOperationLease({
      shop,
      namespace: "TARGET_FREEZE",
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    }).catch(() => {});
  }, 30_000);
  try {
    const session = await getSession(shop);
    if (!session?.shop || session.shop !== shop) {
      throw new Error("Shop session not available for target.freeze stage");
    }

    const service = new ProductBulkService(session);
    const movedToFreezing = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [
        OPERATION_LIFECYCLE_STATES.QUEUED,
        OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      ],
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
        executionStateNormalized: normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.TARGET_FREEZING),
      },
    });
    if (!movedToFreezing) {
      throw new Error("PIPELINE_TARGET_FREEZE_TRANSITION_REJECTED");
    }

    let frozenCount = 0;
    try {
      await assertOperationLeaseOwnership({
        shop,
        namespace: "TARGET_FREEZE",
        resourceId: String(historyId),
        ownerId: leaseOwnerId,
      });
      frozenCount = await service.freezeEditHistoryTargets(historyId);
    } catch (error) {
      await failEditHistoryStage({
        historyId,
        shop,
        stage: "targetFreeze",
        executionId,
        retryable: true,
        error: error.message,
      });
      throw error;
    }
    const movedToFrozen = await guardedEditHistoryUpdate({
      id: historyId,
      shop,
      expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.TARGET_FREEZING],
      data: {
        totalItems: frozenCount,
        targetSnapshotCount: frozenCount,
        executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
        executionStateNormalized: normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.TARGET_FROZEN),
      },
    });
    if (!movedToFrozen) {
      throw new Error("PIPELINE_TARGET_FROZEN_TRANSITION_REJECTED");
    }

    await enqueueBulkEditMutationPlanJob({
      historyId,
      shop,
      executionId,
      source: "pipeline_target_freeze",
    });
    await completeEditHistoryStage({
      historyId,
      shop,
      stage: "targetFreeze",
      executionId,
      checkpoint: { frozenCount },
    });
  } finally {
    clearInterval(leaseHeartbeat);
    await releaseOperationLease({
      shop,
      namespace: "TARGET_FREEZE",
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    });
  }
}

async function processMutationPlan(jobData) {
  const { historyId, shop, executionId } = jobData;
  const history = await db.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      executionIdentity: true,
      executionState: true,
      batch: true,
    },
  });
  if (!history) {
    throw new Error("Edit history not found for mutation.plan stage");
  }
  if (history.executionIdentity && executionId && history.executionIdentity !== executionId) {
    throw new Error("STALE_EXECUTION_JOB");
  }
  assertPipelineExecutionState(history, [OPERATION_LIFECYCLE_STATES.TARGET_FROZEN]);
  const operationKey = history?.batch?.operationKey || history?.batch?.executionPlan?.operationKey || null;
  assertValidOperationKey(operationKey);

  const movedToPlanned = await guardedEditHistoryUpdate({
    id: historyId,
    shop,
    expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.TARGET_FROZEN],
    data: {
      executionState: OPERATION_LIFECYCLE_STATES.PLANNED,
      executionStateNormalized: normalizeEditHistoryExecutionState(OPERATION_LIFECYCLE_STATES.PLANNED),
    },
  });
  if (!movedToPlanned) {
    throw new Error("PIPELINE_MUTATION_PLAN_TRANSITION_REJECTED");
  }

  await enqueueBulkEditExecuteStageJob({
    historyId,
    shop,
    executionId,
    source: "pipeline_mutation_plan",
  });
}

async function processBulkEditExecute(jobData) {
  const { historyId, shop, executionId } = jobData;
  await addBulkEditExecuteJob({
    historyId,
    shop,
    source: "pipeline_bulk_edit_execute",
    executionId,
  });
}

const bulkEditPipelineWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { historyId, shop, executionId } = job.data || {};
    if (!historyId || !shop || !executionId) {
      throw new Error("bulk edit pipeline job requires historyId, shop, and executionId");
    }

    if (job.name === "target.freeze") {
      await processTargetFreeze(job.data);
      return { success: true, stage: "target.freeze" };
    }
    if (job.name === "mutation.plan") {
      await processMutationPlan(job.data);
      return { success: true, stage: "mutation.plan" };
    }
    if (job.name === "bulk.edit.execute") {
      await processBulkEditExecute(job.data);
      return { success: true, stage: "bulk.edit.execute" };
    }

    throw new Error(`Unsupported bulk edit pipeline job: ${job.name}`);
  },
  { connection, concurrency: 3 },
);

bulkEditPipelineWorker.on("completed", (job, result) => {
  logger.info("Bulk edit pipeline stage completed", {
    worker: "bulkEditPipelineWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    stage: job?.name,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    result,
  });
});

bulkEditPipelineWorker.on("failed", async (job, error) => {
  logger.error("Bulk edit pipeline stage failed", {
    worker: "bulkEditPipelineWorker",
    queue: QUEUE_NAME,
    jobId: job?.id,
    stage: job?.name,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    message: error.message,
  });
  await logWorkerError({
    shop: job?.data?.shop || "unknown",
    err: error,
    source: "bulkEditPipelineWorker",
  });
});

export default bulkEditPipelineWorker;

