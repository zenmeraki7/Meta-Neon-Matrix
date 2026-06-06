import { UnrecoverableError, Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { BulkEditVerificationService } from "../../services/bulkEdit/BulkEditVerificationService.js";
import { normalizeEditHistoryExecutionState } from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../services/operationLifecycleStateMachine.js";
import { guardedEditHistoryUpdate } from "../../services/operationTransitionGuards.js";
import { getSession } from "../../utils/sessionHandler.js";
import logger from "../../utils/loggerUtils.js";
import { logWorkerError } from "../../utils/errorLogUtils.js";
import {
  getJobAttempt,
  isRetryExhausted,
  recordRetryExhausted,
} from "../../utils/workerTelemetry.js";
import { bulkEditVerificationDlqQueue } from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import {
  acquireOperationLease,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../../services/operationLeaseService.js";

const QUEUE_NAME = process.env.BULK_EDIT_VERIFICATION_QUEUE || "bulk-edit-verification";
const DLQ_NAME =
  process.env.BULK_EDIT_VERIFICATION_DLQ_QUEUE || "bulk-edit-verification-dlq";
const WORKER_NAME = "bulkEditVerificationWorker";
const TERMINAL_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.CANCELLED,
  OPERATION_LIFECYCLE_STATES.COMPLETED,
  OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
  OPERATION_LIFECYCLE_STATES.FAILED,
]);

function nonRetryableError(message) {
  const error = new Error(message);
  error.nonRetryable = true;
  return error;
}

async function processBulkEditVerification(job) {
  const { historyId, shop, executionId = null } = job.data || {};
  if (!historyId || !shop) {
    throw new UnrecoverableError("bulk edit verification job requires historyId and shop");
  }
  let leaseOwnerId = null;
  let leaseHeartbeat = null;

  try {
    const [history, store] = await Promise.all([
      db.editHistory.findFirst({
        where: { id: historyId, shop },
        select: {
          id: true,
          shop: true,
          executionIdentity: true,
          executionState: true,
          cancelRequestedAt: true,
        },
      }),
      db.store.findUnique({
        where: { shopUrl: shop },
        select: { isUnInstalled: true },
      }),
    ]);

    if (!history) throw nonRetryableError("EDIT_HISTORY_NOT_FOUND");
    if (!store || store.isUnInstalled) {
      return { skipped: true, reason: "shop_not_installed", historyId, shop };
    }
    if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
      return { skipped: true, reason: "stale_execution_identity", historyId, shop };
    }
    if (history.cancelRequestedAt) {
      return { skipped: true, reason: "operation_cancel_requested", historyId, shop };
    }
    if (TERMINAL_STATES.has(history.executionState)) {
      return { skipped: true, reason: "operation_already_terminal", historyId, shop };
    }

    leaseOwnerId = buildLeaseOwnerId("bulk-edit-verification");
    const lease = await acquireOperationLease({
      shop,
      namespace: "BULK_EDIT_VERIFICATION",
      resourceId: historyId,
      ownerId: leaseOwnerId,
      ttlMs: 600_000,
    });
    if (!lease?.acquired) {
      return { skipped: true, reason: "verification_already_in_progress", historyId, shop };
    }
    leaseHeartbeat = setInterval(() => {
      void heartbeatOperationLease({
        shop,
        namespace: "BULK_EDIT_VERIFICATION",
        resourceId: historyId,
        ownerId: leaseOwnerId,
        ttlMs: 600_000,
      }).catch(() => {});
    }, 60_000);
    leaseHeartbeat.unref?.();

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
      extraWhere: {
        batch: {
          path: ["verification", "verifiedAt"],
          equals: null,
        },
      },
    });
    if (!updated) {
      const current = await db.editHistory.findFirst({
        where: { id: historyId, shop },
        select: { executionState: true, batch: true },
      });
      if (current?.batch?.verification?.verifiedAt) {
        return { skipped: true, reason: "already_verified_concurrent", historyId, shop };
      }
      throw nonRetryableError(
        `EDIT_HISTORY_NOT_IN_VERIFIABLE_STATE:${current?.executionState || "NOT_FOUND"}`,
      );
    }

    let session;
    try {
      session = await getSession(shop);
    } catch {
      throw nonRetryableError("SHOP_SESSION_NOT_AVAILABLE");
    }
    if (!session?.accessToken || session.shop !== shop) {
      throw nonRetryableError("SHOP_SESSION_NOT_AVAILABLE");
    }

    const service = new BulkEditVerificationService(session);
    return await service.verifyBatch({ shop, historyId, executionId });
  } catch (error) {
    logger.error("Bulk edit verification processor failed", {
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      jobId: job.id,
      shop,
      historyId,
      executionId,
      attempt: getJobAttempt(job),
      message: error?.message,
    });
    await logWorkerError({
      shop,
      err: error,
      source: WORKER_NAME,
      metadata: {
        queue: QUEUE_NAME,
        worker: WORKER_NAME,
        jobId: job?.id || null,
        historyId,
        executionId,
        attempt: getJobAttempt(job),
      },
    });
    if (error?.nonRetryable) throw new UnrecoverableError(error.message);
    throw error;
  } finally {
    if (leaseHeartbeat) clearInterval(leaseHeartbeat);
    if (leaseOwnerId) {
      await releaseOperationLease({
        shop,
        namespace: "BULK_EDIT_VERIFICATION",
        resourceId: historyId,
        ownerId: leaseOwnerId,
      }).catch(() => {});
    }
  }
}

const bulkEditVerificationWorker = new Worker(
  QUEUE_NAME,
  processBulkEditVerification,
  {
    connection,
    concurrency: 2,
    lockDuration: Number(process.env.BULK_EDIT_VERIFICATION_LOCK_DURATION_MS || 600_000),
    stalledInterval: Number(
      process.env.BULK_EDIT_VERIFICATION_STALLED_INTERVAL_MS || 60_000,
    ),
    maxStalledCount: Number(process.env.BULK_EDIT_VERIFICATION_MAX_STALLED_COUNT || 1),
  },
);

bulkEditVerificationWorker.on("completed", (job, result) => {
  logger.info("Bulk edit verification completed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    executionId: job?.data?.executionId || null,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  });
});

bulkEditVerificationWorker.on("failed", (job, error) => {
  logger.error("Bulk edit verification failed", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId: job?.id,
    shop: job?.data?.shop,
    historyId: job?.data?.historyId,
    executionId: job?.data?.executionId || null,
    attemptsMade: job?.attemptsMade,
    maxAttempts: job?.opts?.attempts,
    message: error?.message,
    stack: error?.stack,
  });

  if (isRetryExhausted(job) || error?.name === "UnrecoverableError") {
    void db.editHistory.updateMany({
      where: {
        id: job?.data?.historyId,
        shop: job?.data?.shop,
        executionState: OPERATION_LIFECYCLE_STATES.VERIFYING,
      },
      data: {
        status: "failed",
        statusNormalized: "FAILED",
        executionState: OPERATION_LIFECYCLE_STATES.FAILED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.FAILED,
        ),
      },
    }).catch(() => {});
    void recordRetryExhausted({
      job,
      shop: job?.data?.shop,
      worker: WORKER_NAME,
      queue: QUEUE_NAME,
      entityType: "editHistory",
      entityId: job?.data?.historyId,
      executionId: job?.data?.executionId || null,
      message: "Bulk edit verification exhausted retries",
    }).catch(() => {});
    void bulkEditVerificationDlqQueue.add(
      DLQ_NAME,
      {
        originalJobId: job?.id,
        data: job?.data,
        failedReason: error?.message,
        stack: error?.stack,
        failedAt: new Date().toISOString(),
      },
      { jobId: `dlq:${QUEUE_NAME}:${job?.id}` },
    ).catch((dlqError) => {
      logger.error("Bulk edit verification DLQ enqueue failed", {
        worker: WORKER_NAME,
        jobId: job?.id,
        message: dlqError?.message,
      });
    });
  }
});

bulkEditVerificationWorker.on("stalled", (jobId) => {
  logger.warn("Bulk edit verification stalled", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    jobId,
  });
});

bulkEditVerificationWorker.on("error", (error) => {
  logger.error("Bulk edit verification worker error", {
    worker: WORKER_NAME,
    queue: QUEUE_NAME,
    message: error?.message,
    stack: error?.stack,
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await bulkEditVerificationWorker.close();
  } catch (error) {
    logger.error("Bulk edit verification shutdown failed", {
      worker: WORKER_NAME,
      signal,
      message: error?.message,
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default bulkEditVerificationWorker;
