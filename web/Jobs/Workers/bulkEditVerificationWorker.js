import { QueueEvents, Worker } from "bullmq";
import { connection, createRedisConnection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { BulkEditVerificationService } from "../../services/bulkEdit/BulkEditVerificationService.js";
import {
  normalizeEditHistoryExecutionState,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { guardedEditHistoryUpdate } from "../../services/operationTransitionGuards.js";
import {
  acquireOperationLease,
  assertOperationLeaseOwnership,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";
import {
  bulkEditVerificationDlqQueue,
} from "../../queues/adapters/jobsQueueInstancesAdapter.js";

const WORKER_NAME = "bulkEditVerificationWorker";
const QUEUE_NAME =
  process.env.BULK_EDIT_VERIFICATION_QUEUE || "bulk-edit-verification";

const LEASE_NAMESPACE = "BULK_EDIT_VERIFICATION";

function safeMessage(error) {
  return String(error?.message || error || "Unknown error").slice(0, 1000);
}

function getMaxAttempts(job) {
  return Number(job?.opts?.attempts || 1);
}

function hasExhaustedRetry(job) {
  return Number(job?.attemptsMade || 0) + 1 >= getMaxAttempts(job);
}

function isRetryableVerificationError(error) {
  if (error?.nonRetryable === true) return false;
  if (error?.retryable === true) return true;

  const msg = safeMessage(error);

  if (
    msg.includes("SHOP_MISMATCH") ||
    msg.includes("STALE_EXECUTION_JOB") ||
    msg.includes("OPERATION_CANCEL_REQUESTED") ||
    msg.includes("operation_already_terminal") ||
    msg.includes("already_verified")
  ) {
    return false;
  }

  return (
    msg.includes("LEASE") ||
    msg.includes("LOCK") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("RETRYABLE")
  );
}

async function withVerificationLease({ shop, historyId, run }) {
  const ownerId = buildLeaseOwnerId("bulk-edit-verification");

  const lease = await acquireOperationLease({
    shop,
    namespace: LEASE_NAMESPACE,
    resourceId: String(historyId),
    ownerId,
  });

  if (!lease?.acquired) {
    const error = new Error("BULK_EDIT_VERIFICATION_LEASE_BUSY");
    error.retryable = true;
    throw error;
  }

  let heartbeatLost = false;

  const heartbeat = setInterval(() => {
    heartbeatOperationLease({
      shop,
      namespace: LEASE_NAMESPACE,
      resourceId: String(historyId),
      ownerId,
    }).catch((error) => {
      heartbeatLost = true;
      logger.error("Bulk edit verification lease heartbeat failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        historyId,
        shop,
        message: safeMessage(error),
      });
    });
  }, Number(process.env.BULK_EDIT_VERIFICATION_LEASE_HEARTBEAT_MS || 20000));

  async function assertLeaseAlive() {
    if (heartbeatLost) {
      const error = new Error("BULK_EDIT_VERIFICATION_LEASE_HEARTBEAT_LOST");
      error.retryable = true;
      throw error;
    }

    await assertOperationLeaseOwnership({
      shop,
      namespace: LEASE_NAMESPACE,
      resourceId: String(historyId),
      ownerId,
    });
  }

  try {
    return await run({ assertLeaseAlive });
  } finally {
    clearInterval(heartbeat);

    await releaseOperationLease({
      shop,
      namespace: LEASE_NAMESPACE,
      resourceId: String(historyId),
      ownerId,
    }).catch((error) => {
      logger.error("Bulk edit verification lease release failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        historyId,
        shop,
        message: safeMessage(error),
      });
    });
  }
}

async function processBulkEditVerification(job) {
  const { historyId, shop, executionId = null } = job.data || {};

  if (!historyId || !shop) {
    const error = new Error("bulk edit verification job requires historyId and shop");
    error.nonRetryable = true;
    throw error;
  }

  return withVerificationLease({
    shop,
    historyId,
    run: async ({ assertLeaseAlive }) => {
      const history = await db.editHistory.findFirst({
        where: { id: historyId, shop },
        select: {
          id: true,
          shop: true,
          executionIdentity: true,
          batch: true,
          executionStateNormalized: true,
          executionState: true,
          cancelRequestedAt: true,
        },
      });

      if (!history) {
        const error = new Error("Edit history not found");
        error.retryable = true;
        throw error;
      }

      if (
        executionId &&
        history.executionIdentity &&
        executionId !== history.executionIdentity
      ) {
        return { skipped: true, reason: "stale_execution_identity", historyId, shop };
      }

      if (history.cancelRequestedAt) {
        return { skipped: true, reason: "operation_cancel_requested", historyId, shop };
      }

      if (
        [
          OPERATION_LIFECYCLE_STATES.CANCELLED,
          OPERATION_LIFECYCLE_STATES.COMPLETED,
          OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
        ].includes(history.executionState)
      ) {
        return { skipped: true, reason: "operation_already_terminal", historyId, shop };
      }

      if (history.batch?.verification?.verifiedAt) {
        return { skipped: true, reason: "already_verified", historyId, shop };
      }

      await assertLeaseAlive();

      const updated = await guardedEditHistoryUpdate({
        id: historyId,
        shop,
        expectedExecutionStates: [
          OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
          OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
          OPERATION_LIFECYCLE_STATES.VERIFYING,
          OPERATION_LIFECYCLE_STATES.MIRROR_UPDATING,
        ],
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.VERIFYING,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.VERIFYING,
          ),
        },
      });

      if (!updated) {
        const fresh = await db.editHistory.findFirst({
          where: { id: historyId, shop },
          select: { batch: true, executionState: true },
        });

        if (fresh?.batch?.verification?.verifiedAt) {
          return { skipped: true, reason: "already_verified_after_race", historyId, shop };
        }

        throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_VERIFYING");
      }

      await assertLeaseAlive();

      const service = new BulkEditVerificationService();
      const result = await service.verifyBatch({ shop, historyId, executionId });

      await assertLeaseAlive();

      return {
        success: true,
        historyId,
        shop,
        verified: result,
      };
    },
  });
}

export const bulkEditVerificationWorker = new Worker(
  QUEUE_NAME,
  processBulkEditVerification,
  {
    connection,
    concurrency: Number(process.env.BULK_EDIT_VERIFICATION_CONCURRENCY || 2),
    autorun: false,
    lockDuration: Number(process.env.BULK_EDIT_VERIFICATION_LOCK_DURATION_MS || 300000),
    stalledInterval: Number(process.env.BULK_EDIT_VERIFICATION_STALLED_INTERVAL_MS || 60000),
    maxStalledCount: Number(process.env.BULK_EDIT_VERIFICATION_MAX_STALLED_COUNT || 2),
    limiter: {
      max: Number(process.env.BULK_EDIT_VERIFICATION_LIMIT_MAX || 4),
      duration: Number(process.env.BULK_EDIT_VERIFICATION_LIMIT_DURATION_MS || 1000),
    },
  },
);

const bulkEditVerificationQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection(),
});

bulkEditVerificationQueueEvents.on("failed", ({ jobId, failedReason }) => {
  logger.error("Bulk edit verification queue event failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
    failedReason,
  });
});

bulkEditVerificationQueueEvents.on("stalled", ({ jobId }) => {
  logger.warn("Bulk edit verification queue event stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkEditVerificationWorker.on("completed", (job, result) => {
  logger.info("Bulk edit verification worker completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    success: Boolean(result?.success),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

bulkEditVerificationWorker.on("failed", async (job, error) => {
  const attemptsMade = Number(job?.attemptsMade || 0);
  const maxAttempts = Number(job?.opts?.attempts || 1);

  if (hasExhaustedRetry(job)) {
    await bulkEditVerificationDlqQueue.add(
      "bulk-edit-verification-dlq",
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
      logger.error("Bulk edit verification DLQ enqueue failed", {
        worker: WORKER_NAME,
        queue: QUEUE_NAME,
        originalJobId: job?.id,
        message: safeMessage(dlqError),
      });
    });
  }

  logger.error("Bulk edit verification worker failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    historyId: job?.data?.historyId,
    shop: job?.data?.shop,
    attemptsMade,
    maxAttempts,
    retryable: isRetryableVerificationError(error),
    message: safeMessage(error),
  });
});

bulkEditVerificationWorker.on("error", (error) => {
  logger.error("Bulk edit verification worker runtime error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: safeMessage(error),
    stack: error?.stack,
  });
});

export function startBulkEditVerificationWorker() {
  if (
    !startBulkEditVerificationWorker.started &&
    !bulkEditVerificationWorker.isRunning()
  ) {
    startBulkEditVerificationWorker.started = true;
    bulkEditVerificationWorker.run();

    logger.info("Bulk edit verification worker started", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
    });
  }

  return bulkEditVerificationWorker;
}

startBulkEditVerificationWorker.started = false;

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info("Closing bulk edit verification worker", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    signal,
  });

  const timeout = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("BULK_EDIT_VERIFICATION_WORKER_CLOSE_TIMEOUT")),
      25_000,
    ),
  );

  try {
    await Promise.race([
      (async () => {
        await bulkEditVerificationWorker.close();
        await bulkEditVerificationQueueEvents.close();
      })(),
      timeout,
    ]);
  } catch (error) {
    logger.error("Bulk edit verification worker shutdown failed", {
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

export default bulkEditVerificationWorker;