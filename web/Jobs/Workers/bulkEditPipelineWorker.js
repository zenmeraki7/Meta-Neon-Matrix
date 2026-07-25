// web/Jobs/Workers/bulkEditPipelineWorker.js

import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import { getSession } from "../../utils/sessionHandler.js";
import ProductBulkService from "../../services/productService/productBulkEditService.js";
import {
  enqueueBulkEditExecuteStageJob,
  enqueueBulkEditMutationPlanJob,
  enqueueBulkEditItemApplyDispatchJob,
} from "../Queues/bulkEditPipelineJob.js";
import { addBulkEditExecuteJob } from "../Queues/bulkEditExecuteJob.js";
import { bulkEditItemApplyQueue, bulkEditPipelineDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
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

const WORKER_NAME = "bulkEditPipelineWorker";
const QUEUE_NAME = process.env.BULK_EDIT_PIPELINE_QUEUE || "bulk-edit-pipeline";

const WORKER_CONCURRENCY = Number.parseInt(
  process.env.BULK_EDIT_PIPELINE_WORKER_CONCURRENCY || "3",
  10,
);

const PIPELINE_STAGE_KEYS = Object.freeze({
  TARGET_FREEZE: "TARGET_FREEZE",
  MUTATION_PLAN: "MUTATION_PLAN",
  EXECUTE_DISPATCH: "EXECUTE_DISPATCH",
  ITEM_APPLY_DISPATCH: "ITEM_APPLY_DISPATCH",
});

const DIRECT_ITEM_OPERATION_KEYS = new Set([
  "METAFIELD_DIRECT_APPLY",
  "PRODUCT_FIELD_DIRECT_APPLY",
]);

function safeMessage(error) {
  return String(error?.message || error || "Unknown error").slice(0, 1000);
}

function isRetryablePipelineError(error) {
  if (error?.nonRetryable === true) return false;
  if (error?.retryable === true) return true;

  const message = safeMessage(error);

  if (
    message.includes("STALE_EXECUTION_JOB") ||
    message.includes("OPERATION_CANCEL_REQUESTED") ||
    message.includes("INVALID_OPERATION") ||
    message.includes("PIPELINE_STATE_CONFLICT") ||
    message.includes("Shop session not available")
  ) {
    return false;
  }

  return (
    message.includes("LEASE") ||
    message.includes("LOCK") ||
    message.includes("ECONNRESET") ||
    message.includes("ETIMEDOUT") ||
    message.includes("RETRYABLE")
  );
}

function assertPipelineExecutionState(history, allowedStates = []) {
  const state = String(history?.executionState || "").toUpperCase();

  if (!allowedStates.includes(state)) {
    const error = new Error(`PIPELINE_STATE_CONFLICT:${state}`);
    error.nonRetryable = true;
    throw error;
  }
}

async function withStageLease({ shop, historyId, namespace, ownerPrefix, run }) {
  const leaseOwnerId = buildLeaseOwnerId(ownerPrefix);

  const lease = await acquireOperationLease({
    shop,
    namespace,
    resourceId: String(historyId),
    ownerId: leaseOwnerId,
  });

  if (!lease?.acquired) {
    const error = new Error(`${namespace}_LEASE_CONFLICT`);
    error.retryable = true;
    throw error;
  }

  let heartbeatLost = false;

  const leaseHeartbeat = setInterval(() => {
    heartbeatOperationLease({
      shop,
      namespace,
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    }).catch((error) => {
      heartbeatLost = true;
      logger.error("Bulk edit pipeline lease heartbeat failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        namespace,
        shop,
        historyId,
        message: safeMessage(error),
      });
    });
  }, 30_000);

  try {
    const assertLeaseAlive = async () => {
      if (heartbeatLost) {
        const error = new Error(`${namespace}_LEASE_HEARTBEAT_LOST`);
        error.retryable = true;
        throw error;
      }

      await assertOperationLeaseOwnership({
        shop,
        namespace,
        resourceId: String(historyId),
        ownerId: leaseOwnerId,
      });
    };

    return await run({
      lease,
      leaseOwnerId,
      assertLeaseAlive,
    });
  } finally {
    clearInterval(leaseHeartbeat);

    await releaseOperationLease({
      shop,
      namespace,
      resourceId: String(historyId),
      ownerId: leaseOwnerId,
    }).catch((error) => {
      logger.error("Bulk edit pipeline lease release failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        namespace,
        shop,
        historyId,
        message: safeMessage(error),
      });
    });
  }
}

async function loadPipelineHistory({ historyId, shop }) {
  return db.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      id: true,
      shop: true,
      cancelRequestedAt: true,
      executionIdentity: true,
      executionState: true,
      batch: true,
    },
  });
}

function assertHistoryRunnable({ history, historyId, shop, executionId }) {
  if (!history) {
    throw new Error("Edit history not found for pipeline stage");
  }

  if (history.id !== historyId || history.shop !== shop) {
    const error = new Error("PIPELINE_HISTORY_JOB_MISMATCH");
    error.nonRetryable = true;
    throw error;
  }

  if (history.cancelRequestedAt) {
    const error = new Error("OPERATION_CANCEL_REQUESTED");
    error.nonRetryable = true;
    throw error;
  }

  if (
    history.executionIdentity &&
    executionId &&
    history.executionIdentity !== executionId
  ) {
    const error = new Error("STALE_EXECUTION_JOB");
    error.nonRetryable = true;
    throw error;
  }
}

async function processTargetFreeze(jobData) {
  const { historyId, shop, executionId } = jobData;

  const stageRun = await beginEditHistoryStage({
    historyId,
    shop,
    stage: PIPELINE_STAGE_KEYS.TARGET_FREEZE,
    executionId,
  });

  if (stageRun.state === "completed" || stageRun.state === "stale") return;

  if (stageRun.state === "running") {
    const error = new Error("TARGET_FREEZE_STAGE_ALREADY_RUNNING");
    error.retryable = true;
    throw error;
  }

  await withStageLease({
    shop,
    historyId,
    namespace: "TARGET_FREEZE",
    ownerPrefix: "bulk-edit-target-freeze",
    run: async ({ assertLeaseAlive }) => {
      const history = await loadPipelineHistory({ historyId, shop });

      assertHistoryRunnable({ history, historyId, shop, executionId });

      assertPipelineExecutionState(history, [
        OPERATION_LIFECYCLE_STATES.QUEUED,
        OPERATION_LIFECYCLE_STATES.SCHEDULED_QUEUED,
        OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      ]);

      const session = await getSession(shop);

      if (!session?.shop || session.shop !== shop) {
        const error = new Error("Shop session not available for target.freeze stage");
        error.nonRetryable = true;
        throw error;
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
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
          ),
        },
      });

      if (!movedToFreezing) {
        throw new Error("PIPELINE_TARGET_FREEZE_TRANSITION_REJECTED");
      }

      let frozenCount = 0;

      try {
        await assertLeaseAlive();
        frozenCount = await service.freezeEditHistoryTargets(historyId);
      } catch (error) {
        await failEditHistoryStage({
          historyId,
          shop,
          stage: PIPELINE_STAGE_KEYS.TARGET_FREEZE,
          executionId,
          retryable: isRetryablePipelineError(error),
          error: safeMessage(error),
        });
        throw error;
      }

      await assertLeaseAlive();

      const movedToFrozen = await guardedEditHistoryUpdate({
        id: historyId,
        shop,
        expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.TARGET_FREEZING],
        data: {
          totalItems: frozenCount,
          targetSnapshotCount: frozenCount,
          executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
          ),
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
        stage: PIPELINE_STAGE_KEYS.TARGET_FREEZE,
        executionId,
        checkpoint: { frozenCount },
      });
    },
  });
}

async function processMutationPlan(jobData) {
  const { historyId, shop, executionId } = jobData;

  const stageRun = await beginEditHistoryStage({
    historyId,
    shop,
    stage: PIPELINE_STAGE_KEYS.MUTATION_PLAN,
    executionId,
  });

  if (stageRun.state === "completed" || stageRun.state === "stale") return;

  if (stageRun.state === "running") {
    const error = new Error("MUTATION_PLAN_STAGE_ALREADY_RUNNING");
    error.retryable = true;
    throw error;
  }

  await withStageLease({
    shop,
    historyId,
    namespace: "MUTATION_PLAN",
    ownerPrefix: "bulk-edit-mutation-plan",
    run: async ({ assertLeaseAlive }) => {
      const history = await loadPipelineHistory({ historyId, shop });

      assertHistoryRunnable({ history, historyId, shop, executionId });
      assertPipelineExecutionState(history, [OPERATION_LIFECYCLE_STATES.TARGET_FROZEN]);

      const operationKey =
        history?.batch?.operationKey ||
        history?.batch?.executionPlan?.operationKey ||
        null;

      assertValidOperationKey(operationKey);

      await assertLeaseAlive();

      const movedToPlanned = await guardedEditHistoryUpdate({
        id: historyId,
        shop,
        expectedExecutionStates: [OPERATION_LIFECYCLE_STATES.TARGET_FROZEN],
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.PLANNED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.PLANNED,
          ),
        },
      });

      if (!movedToPlanned) {
        throw new Error("PIPELINE_MUTATION_PLAN_TRANSITION_REJECTED");
      }

      if (DIRECT_ITEM_OPERATION_KEYS.has(operationKey)) {
        await enqueueBulkEditItemApplyDispatchJob({
          historyId,
          shop,
          executionId,
          source: "pipeline_mutation_plan",
        });
      } else {
        await enqueueBulkEditExecuteStageJob({
          historyId,
          shop,
          executionId,
          source: "pipeline_mutation_plan",
        });
      }

      await completeEditHistoryStage({
        historyId,
        shop,
        stage: PIPELINE_STAGE_KEYS.MUTATION_PLAN,
        executionId,
        checkpoint: { operationKey },
      });
    },
  });
}

async function processBulkEditExecute(jobData) {
  const { historyId, shop, executionId } = jobData;

  const stageRun = await beginEditHistoryStage({
    historyId,
    shop,
    stage: PIPELINE_STAGE_KEYS.EXECUTE_DISPATCH,
    executionId,
  });

  if (stageRun.state === "completed" || stageRun.state === "stale") return;

  const history = await loadPipelineHistory({ historyId, shop });

  assertHistoryRunnable({ history, historyId, shop, executionId });

  assertPipelineExecutionState(history, [
    OPERATION_LIFECYCLE_STATES.PLANNED,
    OPERATION_LIFECYCLE_STATES.QUEUED,
  ]);

  await addBulkEditExecuteJob(
    {
      historyId,
      shop,
      source: "pipeline_bulk_edit_execute",
      executionId,
    },
    {
      attempts: 6,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 86400, count: 1000 },
      removeOnFail: { age: 604800, count: 5000 },
    },
  );

  await completeEditHistoryStage({
    historyId,
    shop,
    stage: PIPELINE_STAGE_KEYS.EXECUTE_DISPATCH,
    executionId,
    checkpoint: { dispatched: true },
  });
}

async function processItemApplyDispatch(jobData) {
  const { historyId, shop, executionId } = jobData;

  const stageRun = await beginEditHistoryStage({
    historyId,
    shop,
    stage: PIPELINE_STAGE_KEYS.ITEM_APPLY_DISPATCH,
    executionId,
  });

  if (stageRun.state === "completed" || stageRun.state === "stale") return;

  const history = await loadPipelineHistory({ historyId, shop });

  assertHistoryRunnable({ history, historyId, shop, executionId });
  assertPipelineExecutionState(history, [OPERATION_LIFECYCLE_STATES.PLANNED]);

  const items = await db.targetSnapshotItem.findMany({
    where: {
      operationId: historyId,
      shop,
      executionStatus: "PENDING",
      targetResourceType: "METAFIELD",
    },
    select: {
      id: true,
      operationId: true,
      shop: true,
      productId: true,
      variantId: true,
      targetKey: true,
      targetResourceType: true,
      plannedMutation: true,
    },
  });

  if (!items.length) {
    await completeEditHistoryStage({
      historyId,
      shop,
      stage: PIPELINE_STAGE_KEYS.ITEM_APPLY_DISPATCH,
      executionId,
      checkpoint: { dispatchedCount: 0 },
    });
    return;
  }

  const jobs = items.map((item) => {
    const mutation = item.plannedMutation || {};
    const metafield =
      mutation.metafield ||
      mutation.metafieldsSetInput ||
      mutation.input ||
      mutation;

    const ownerId = String(
      metafield.ownerId ||
      metafield.owner_id ||
      item.variantId ||
      item.productId ||
      "",
    ).trim();

    const namespace = String(metafield.namespace || "").trim();
    const key = String(metafield.key || "").trim();
    const type = String(metafield.type || metafield.valueType || "").trim();
    const value = metafield.value ?? metafield.newValue ?? "";

    if (!ownerId || !namespace || !key || !type) {
      throw new Error(`INVALID_METAFIELD_SNAPSHOT_ITEM:${item.id}`);
    }

    return {
      name: "apply-metafield-item",
      data: {
        bulkApplyJobId: historyId,
        itemId: item.id,
        shop,
        ownerId,
        namespace,
        key,
        type,
        value,
      },
      opts: {
        jobId: `bulk-edit-item:${historyId}:${item.id}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 5000 },
      },
    };
  });

  await bulkEditItemApplyQueue.addBulk(jobs);

  await completeEditHistoryStage({
    historyId,
    shop,
    stage: PIPELINE_STAGE_KEYS.ITEM_APPLY_DISPATCH,
    executionId,
    checkpoint: { dispatchedCount: jobs.length },
  });
}

export const bulkEditPipelineWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { historyId, shop, executionId } = job.data || {};

    if (!historyId || !shop || !executionId) {
      const error = new Error("bulk edit pipeline job requires historyId, shop, and executionId");
      error.nonRetryable = true;
      throw error;
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

    if (job.name === "item.apply.dispatch") {
      await processItemApplyDispatch(job.data);
      return { success: true, stage: "item.apply.dispatch" };
    }

    const error = new Error(`Unsupported bulk edit pipeline job: ${job.name}`);
    error.nonRetryable = true;
    throw error;
  },
  {
    connection,
    concurrency: Number.isFinite(WORKER_CONCURRENCY) ? WORKER_CONCURRENCY : 3,
    autorun: false,
    lockDuration: Number(process.env.BULK_EDIT_PIPELINE_LOCK_DURATION_MS || 300000),
    stalledInterval: Number(process.env.BULK_EDIT_PIPELINE_STALLED_INTERVAL_MS || 60000),
    maxStalledCount: Number(process.env.BULK_EDIT_PIPELINE_MAX_STALLED_COUNT || 2),
  },
);

const bulkEditPipelineQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection(),
});

bulkEditPipelineQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Bulk edit pipeline queue event failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
    failedReason,
  });
});

bulkEditPipelineQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Bulk edit pipeline queue event stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkEditPipelineWorker.on("completed", (job, result) => {
  logger.info("Bulk edit pipeline stage completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    stage: job?.name,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    result,
  });
});

bulkEditPipelineWorker.on("failed", async (job, error) => {
  const attemptsMade = Number(job?.attemptsMade || 0);
  const maxAttempts = Number(job?.opts?.attempts || 1);

  if (attemptsMade >= maxAttempts) {
    await bulkEditPipelineDlqQueue.add(
      "bulk-edit-pipeline-dlq",
      {
        originalQueue: QUEUE_NAME,
        originalJobId: job?.id,
        originalJobName: job?.name,
        data: job?.data,
        failedReason: safeMessage(error),
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      {
        jobId: `dlq:${QUEUE_NAME}:${job?.id}`,
        removeOnComplete: { age: 604800, count: 5000 },
      },
    ).catch((dlqError) => {
      logger.error("Bulk edit pipeline DLQ enqueue failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        originalJobId: job?.id,
        message: safeMessage(dlqError),
      });
    });
  }

  logger.error("Bulk edit pipeline stage failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    stage: job?.name,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    attemptsMade,
    maxAttempts,
    message: safeMessage(error),
  });

  await logWorkerError({
    shop: job?.data?.shop || "unknown",
    err: error,
    source: WORKER_NAME,
  }).catch(() => {});
});

bulkEditPipelineWorker.on("error", (error) => {
  logger.error("Bulk edit pipeline worker runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: safeMessage(error),
    stack: error?.stack,
  });
});

export function startBulkEditPipelineWorker() {
  if (!startBulkEditPipelineWorker.started && !bulkEditPipelineWorker.isRunning()) {
    startBulkEditPipelineWorker.started = true;
    bulkEditPipelineWorker.run();

    logger.info("Bulk edit pipeline worker started", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      concurrency: Number.isFinite(WORKER_CONCURRENCY) ? WORKER_CONCURRENCY : 3,
    });
  }

  return bulkEditPipelineWorker;
}

startBulkEditPipelineWorker.started = false;

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Closing bulk edit pipeline worker", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    signal,
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("BULK_EDIT_PIPELINE_WORKER_CLOSE_TIMEOUT")), 25_000),
  );

  try {
    await Promise.race([
      (async () => {
        await bulkEditPipelineWorker.close();
        await bulkEditPipelineQueueEvents.close();
      })(),
      timeout,
    ]);
  } catch (error) {
    logger.error("Bulk edit pipeline worker shutdown failed", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      message: safeMessage(error),
      stack: error?.stack,
    });

    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkEditPipelineWorker;
